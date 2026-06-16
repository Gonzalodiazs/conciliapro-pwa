/* ConciliaPro · Conexión directa a Supabase (sin backend propio).
   La app sube el PDF al Storage y guarda la factura en la tabla `documentos`.
   La anon key es pública (segura en el navegador) y está protegida por RLS. */
(function () {
  var URL = 'https://ekmkzaogpnnqcctcnqpr.supabase.co';
  var KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVrbWt6YW9ncG5ucWNjdGNucXByIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEwMjE3NTAsImV4cCI6MjA5NjU5Nzc1MH0.4tuDPgrfsSXHsSiBVcrnDZbFymdR62wvJj0aSIdcm7s';
  // Headers con el JWT del conductor (de cp_token); fallback a anon antes de login.
  function tok() { return localStorage.getItem('cp_token') || KEY; }
  function H() { return { apikey: KEY, Authorization: 'Bearer ' + tok() }; }
  function perfil() { try { return JSON.parse(localStorage.getItem('cp_perfil') || '{}'); } catch (e) { return {}; } }

  function dataUrlToBlob(d) {
    var b = atob(d.split(',')[1]); var a = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return new Blob([a], { type: 'application/pdf' });
  }

  function uploadPDF(dataUrl) {
    if (!dataUrl) return Promise.resolve(null);
    var name = 'dte-' + new Date().getTime() + '-' + Math.floor(Math.random() * 1e6) + '.pdf';
    return fetch(URL + '/storage/v1/object/comprobantes/' + name, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/pdf' }, H()),
      body: dataUrlToBlob(dataUrl)
    }).then(function (r) { return r.ok ? (URL + '/storage/v1/object/public/comprobantes/' + name) : null; })
      .catch(function () { return null; });
  }

  // Inserta una factura. Sube el PDF primero (si hay) y guarda la fila.
  function insertDoc(doc) {
    return uploadPDF(doc.pdf).then(function (pdf_url) {
      var row = {
        folio: doc.folio || '', dte_tipo: doc.dteTipo || '', dte_nombre: doc.dteNombre || doc.tipo || 'Documento',
        rut: doc.rut || '', rut_receptor: doc.rutReceptor || '', fecha: doc.fecha || '',
        monto: Number(doc.monto) || Number(doc.valorConIva) || 0, glosa: doc.glosa || '',
        // 6 campos solicitados
        codigo_cliente: doc.codigoCliente || '', codigo_transporte: doc.codigoTransporte || '',
        orden_compra: doc.ordenCompra || '',
        valor_sin_iva: Number(doc.valorSinIva) || 0, valor_con_iva: Number(doc.valorConIva) || Number(doc.monto) || 0,
        forma_pago: (doc.formaPago || '').toUpperCase(), firmante: doc.firmante || '',
        repartidor: doc.repartidor || perfil().nombre || '', patente: doc.patente || perfil().patente || '', fuente: doc.fuente || '',
        gps: doc.gps || null, pdf_url: pdf_url, empresa_id: doc.empresaId || perfil().empresa_id || null
      };
      return fetch(URL + '/rest/v1/documentos', {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=representation' }, H()),
        body: JSON.stringify(row)
      }).then(function (r) { if (!r.ok) throw new Error('insert ' + r.status); return r.json().then(function (a) { return a[0]; }); });
    });
  }

  function listDocs() {
    return fetch(URL + '/rest/v1/documentos?select=*&order=ts.desc', { headers: H() })
      .then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; });
  }

  // IA de visión: manda la foto a la Edge Function (que llama a Gemini) y devuelve los datos
  function extraerFactura(imageBase64) {
    return fetch(URL + '/functions/v1/extraer-factura', {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H()),
      body: JSON.stringify({ image: imageBase64 })
    }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return (j && j.ok) ? j.data : null; })
      .catch(function () { return null; });
  }

  function marcarConciliado(id, val) {
    return fetch(URL + '/rest/v1/documentos?id=eq.' + id, {
      method: 'PATCH', headers: Object.assign({ 'Content-Type': 'application/json' }, H()),
      body: JSON.stringify({ conciliado: !!val })
    });
  }

  // ── Cola OFFLINE: si no hay señal, guarda local y sincroniza al volver ──
  var QKEY = 'cp_cola_offline';
  function qGet() { try { return JSON.parse(localStorage.getItem(QKEY) || '[]'); } catch (e) { return []; } }
  function qSet(a) { try { localStorage.setItem(QKEY, JSON.stringify(a)); } catch (e) {} }

  function insertDocSeguro(doc) {
    return insertDoc(doc).catch(function (err) {
      var q = qGet(); q.push({ doc: doc, t: new Date().getTime() }); qSet(q);
      return { _encolado: true, pendientes: q.length };
    });
  }
  function sincronizarCola() {
    var q = qGet();
    if (!q.length) return Promise.resolve(0);
    var ok = 0;
    // procesa en serie para no saturar
    return q.reduce(function (p, item) {
      return p.then(function () {
        return insertDoc(item.doc).then(function () { ok++; item._done = true; }).catch(function () {});
      });
    }, Promise.resolve()).then(function () {
      qSet(q.filter(function (i) { return !i._done; }));
      return ok;
    });
  }
  function pendientes() { return qGet().length; }
  // auto-sincroniza al recuperar señal y al abrir la app
  window.addEventListener('online', function () { sincronizarCola(); });
  setTimeout(function () { if (navigator.onLine) sincronizarCola(); }, 3000);

  window.CPSupabase = { URL: URL, KEY: KEY, uploadPDF: uploadPDF, insertDoc: insertDoc, insertDocSeguro: insertDocSeguro,
    listDocs: listDocs, marcarConciliado: marcarConciliado, extraerFactura: extraerFactura,
    sincronizarCola: sincronizarCola, pendientes: pendientes };
})();
