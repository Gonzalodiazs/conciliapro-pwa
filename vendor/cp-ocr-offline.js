/* ConciliaPro · OCR OFFLINE (Nivel 3) — Tesseract.js empaquetado, funciona SIN internet.
   Todo local: worker, core WASM y español viajan dentro del APK (vendor/tess/).
   Devuelve el mismo formato que la IA (6 campos) extrayendo con regex del texto OCR.
   Es el respaldo de terreno: prellenado + confirmación manual. */
(function () {
  var _worker = null, _loading = null;

  function load() {
    if (_worker) return Promise.resolve(_worker);
    if (_loading) return _loading;
    _loading = (async function () {
      if (!window.Tesseract) throw new Error('tesseract no cargado');
      var base = './vendor/';
      var w = await Tesseract.createWorker('spa', 1, {
        workerPath: base + 'tesseract-worker.min.js',
        corePath:   base + 'tess/tesseract-core-simd-lstm.wasm.js',
        langPath:   base + 'tess/',          // spa.traineddata.gz local
        gzip: true,
        logger: function () {}
      });
      _worker = w; return w;
    })();
    return _loading;
  }

  // ── Preprocesado: reduce a ~1800px + escala de grises + contraste (más rápido y preciso) ──
  function preprocesar(imgOrCanvas) {
    var w0 = imgOrCanvas.naturalWidth || imgOrCanvas.width, h0 = imgOrCanvas.naturalHeight || imgOrCanvas.height;
    var sc = Math.min(1, 1800 / w0);
    var c = document.createElement('canvas'); c.width = Math.round(w0 * sc); c.height = Math.round(h0 * sc);
    var ctx = c.getContext('2d');
    ctx.filter = 'grayscale(1) contrast(1.35) brightness(1.05)';
    ctx.drawImage(imgOrCanvas, 0, 0, c.width, c.height);
    return c;
  }

  // En códigos (letras+números) el OCR confunde O↔0: normaliza O pegada a dígitos
  function normCodigo(s) {
    return String(s || '').replace(/(?<=\d)O|O(?=\d)/g, '0').trim();
  }

  // ── Parser de factura chilena sobre texto OCR ──
  function num(s) { return parseInt(String(s).replace(/[^\d]/g, ''), 10) || 0; }
  function parse(text) {
    var t = (text || '').replace(/\r/g, '');
    var lines = t.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    var out = { tipoDocumento: '', folio: '', codigoCliente: '', codigoTransporte: '', ordenCompra: '',
                fecha: '', rutEmisor: '', rutReceptor: '', valorSinIva: 0, valorConIva: 0, glosa: '', _texto: t };

    if (/FACTURA/i.test(t)) out.tipoDocumento = 'FACTURA ELECTRONICA';
    else if (/BOLETA/i.test(t)) out.tipoDocumento = 'BOLETA ELECTRONICA';
    else if (/GU[IÍ]A/i.test(t)) out.tipoDocumento = 'GUIA DE DESPACHO';

    // Folio: ancla cerca del encabezado del documento ("FACTURA ... N°: 38848344"),
    // evitando N° ENTREGA / N° INTERNO / direcciones. Exige 6-10 dígitos.
    var zona = t; var anc = t.search(/FACTURA|BOLETA|GU[IÍ]A/i);
    if (anc >= 0) zona = t.slice(anc, anc + 400);
    var m = zona.match(/N[°ºo*"”]?\s*[:.]?\s*(\d{6,10})/);
    if (m) out.folio = m[1];
    else { m = t.match(/FOLIO\s*[:.]?\s*(\d{4,12})/i); if (m) out.folio = m[1]; }

    // RUTs: primero = emisor, segundo distinto = receptor
    var ruts = t.match(/\d{1,2}[.\s]?\d{3}[.\s]?\d{3}\s*[-–]\s*[\dkK]/g) || [];
    ruts = ruts.map(function (r) { return r.replace(/\s/g, ''); });
    if (ruts[0]) out.rutEmisor = ruts[0];
    for (var i = 1; i < ruts.length; i++) { if (ruts[i] !== ruts[0]) { out.rutReceptor = ruts[i]; break; } }

    // Fecha: dd/mm/aaaa o "04 de junio de 2026"
    m = t.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})/);
    if (m) out.fecha = m[3] + '-' + ('0'+m[2]).slice(-2) + '-' + ('0'+m[1]).slice(-2);
    else {
      var meses = {enero:'01',febrero:'02',marzo:'03',abril:'04',mayo:'05',junio:'06',julio:'07',agosto:'08',septiembre:'09',octubre:'10',noviembre:'11',diciembre:'12'};
      m = t.match(/(\d{1,2})\s+de\s+([a-zñ]+)\s+de\s+(20\d{2})/i);
      if (m && meses[m[2].toLowerCase()]) out.fecha = m[3] + '-' + meses[m[2].toLowerCase()] + '-' + ('0'+m[1]).slice(-2);
    }

    // Orden de compra
    m = t.match(/ORDEN\s+DE\s+COMPRA\s*[:.]?\s*([A-Z0-9\-\/]{2,15})/i) || t.match(/\bO[\/.]?C\s*[:.]?\s*([A-Z0-9\-\/]{2,15})/i);
    if (m) out.ordenCompra = m[1];

    // Código cliente: Soprole → zona vencimiento (MAITE039 CA923); genérico → COD. CLIENTE
    // exige FECHA real (dd/mm/aaaa) tras VENCIMIENTO y código en MAYÚSCULAS (sin /i: no caza "días")
    m = t.match(/VENCIMIENTO\s*[:.]?\s*\d{1,2}\/\d{1,2}\/\d{2,4}\s+([A-Z][A-Z0-9]{4,9}(?:\s+[A-Z]{1,4}[O0-9]{2,6})?)/);
    if (!m) m = t.match(/COD\.?\s*CLIENTE\s*[:.]?\s*([A-Z][A-Z0-9]{3,14})/);
    if (m) out.codigoCliente = normCodigo(m[1]);

    // Código transporte / patente
    m = t.match(/PATENTE\s*[:.]?\s*([A-Z]{2,4}\s?[A-Z0-9]{2,4})/i) || t.match(/TRANSPORT\w*\s*[:.]?\s*([A-Z0-9\s]{3,12})/i);
    if (m) out.codigoTransporte = m[1].replace(/\s+/g, '').trim();

    // Montos: NETO y TOTAL ($ puede salir como 5/S en OCR)
    var netoM = t.match(/NETO\s*[$5S]?\s*[:.]?\s*([\d.,]{5,15})/gi);
    if (netoM) out.valorSinIva = num(netoM[netoM.length - 1].replace(/NETO\s*[$5S]?\s*[:.]?\s*/i, ''));
    var totM = t.match(/TOTAL\s*\$?\s*[:.]?\s*([\d.,]{3,15})/gi);
    if (totM) {
      // toma el TOTAL mayor (evita "subtotal" de líneas)
      var best = 0;
      totM.forEach(function (x) { var v = num(x.replace(/TOTAL\s*\$?\s*[:.]?\s*/i, '')); if (v > best) best = v; });
      out.valorConIva = best;
    }
    // sanidad: total >= neto; estima el faltante con IVA 19%
    if (!out.valorConIva && out.valorSinIva) out.valorConIva = Math.round(out.valorSinIva * 1.19);
    if (!out.valorSinIva && out.valorConIva) out.valorSinIva = Math.round(out.valorConIva / 1.19);
    if (out.valorConIva && out.valorConIva < out.valorSinIva) { var tmp = out.valorConIva; out.valorConIva = out.valorSinIva; out.valorSinIva = tmp; }

    // ¿extrajo algo útil?
    out._ok = !!(out.folio || out.valorConIva || out.rutEmisor);
    return out;
  }

  window.CPOcrOffline = {
    disponible: function () { return !!window.Tesseract; },
    precargar: load,   // llamar en idle para que el primer uso sea rápido
    /** Lee una imagen/canvas sin internet (preprocesa internamente). @returns Promise<objeto 6 campos | null> */
    leer: function (imgOrCanvas) {
      return load().then(function (w) {
        var prep; try { prep = preprocesar(imgOrCanvas); } catch (e) { prep = imgOrCanvas; }
        return w.recognize(prep).then(function (r) {
          var p = parse(r && r.data ? r.data.text : '');
          return p._ok ? p : null;
        });
      }).catch(function () { return null; });
    },
    _parse: parse // expuesto para pruebas
  };
})();
