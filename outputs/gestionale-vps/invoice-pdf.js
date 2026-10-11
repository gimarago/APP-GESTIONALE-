(function (root) {
  'use strict';

  // Creates a local document. No network requests or invoice transmission occur here.
  async function create(invoice, seller = {}, lib = root.PDFLib, invoices = root.WorkshopInvoices) {
    if (!lib?.PDFDocument || !invoices?.totals) throw Error('Generatore PDF non disponibile. Ricarica l’app.');
    const pdf = await lib.PDFDocument.create();
    const font = await pdf.embedFont(lib.StandardFonts.Helvetica);
    const bold = await pdf.embedFont(lib.StandardFonts.HelveticaBold);
    const ink = lib.rgb(.12, .17, .19), muted = lib.rgb(.37, .42, .44);
    const accent = lib.rgb(.13, .33, .37), line = lib.rgb(.79, .83, .84), pale = lib.rgb(.94, .96, .96);
    const left = 40, right = 555.28, width = right - left, bottom = 65;
    const title = invoice.type === 'TD04' ? 'NOTA DI CREDITO' : invoice.type === 'TD24' ? 'FATTURA DIFFERITA' : 'FATTURA';
    const draft = !invoice.number;
    const number = draft ? 'BOZZA' : String(invoice.number);
    const notice = 'Documento non trasmesso al Sistema di Interscambio';
    const date = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? value.split('-').reverse().join('/') : String(value || '');
    const money = value => Number(value || 0).toLocaleString('it-IT', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    const unitMoney = value => Number(value || 0).toLocaleString('it-IT', {minimumFractionDigits: 2, maximumFractionDigits: 8});
    const quantity = value => Number(value || 0).toLocaleString('it-IT', {maximumFractionDigits: 4});
    const clean = value => Array.from(String(value ?? '').replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(/[\u2010-\u2015]/g, '-')).map(c => {
      if (c === '\n') return c;
      try { font.encodeText(c); return c; } catch (_) { return '?'; }
    }).join('');
    function wrap(value, maxWidth, size = 10, face = font) {
      const result = [];
      for (const paragraph of clean(value).split('\n')) {
        if (!paragraph) { result.push(''); continue; }
        let current = '';
        for (const word of paragraph.split(/\s+/)) {
          const candidate = current ? current + ' ' + word : word;
          if (face.widthOfTextAtSize(candidate, size) <= maxWidth) { current = candidate; continue; }
          if (current) { result.push(current); current = ''; }
          // Long product codes, URLs and fiscal identifiers must not escape their column.
          for (const character of word) {
            if (current && face.widthOfTextAtSize(current + character, size) > maxWidth) { result.push(current); current = ''; }
            current += character;
          }
        }
        result.push(current);
      }
      return result;
    }
    let logo = null;
    if (seller.logo) {
      try {
        if (/^data:image\/png;base64,/i.test(seller.logo)) logo = await pdf.embedPng(seller.logo);
        else if (/^data:image\/jpe?g;base64,/i.test(seller.logo)) logo = await pdf.embedJpg(seller.logo);
        else if (/^data:image\/(svg\+xml|webp)[;,]/i.test(seller.logo) && root.document) {
          const image = new root.Image(); image.src = seller.logo; await image.decode();
          const scale = Math.min(1, 1200 / Math.max(image.naturalWidth, image.naturalHeight));
          const canvas = root.document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
          logo = await pdf.embedPng(canvas.toDataURL('image/png'));
        } else throw Error('Formato non supportato');
      } catch (_) { throw Error('Impossibile inserire il logo nel PDF. Caricalo nuovamente nelle Impostazioni in formato PNG o JPG.'); }
    }
    const totals = invoices.totals(invoice.lines || []);
    const stampDuty = Number(invoice.stampDuty || 0);
    const rounding = Number(invoice.rounding || 0);
    const total = Math.round((totals.total + stampDuty + rounding + Number.EPSILON) * 100) / 100;
    if (![totals.net, totals.tax, total, stampDuty, rounding].every(Number.isFinite)) throw Error('Gli importi del documento non sono validi.');
    pdf.setTitle(clean((draft ? 'Bozza - ' : '') + title + ' ' + number));
    pdf.setAuthor(clean(seller.name || 'Officina'));
    pdf.setSubject(notice);

    let page, y;
    function text(value, x, baseline, size = 10, face = font, color = ink) {
      page.drawText(clean(value), {x, y: baseline, size, font: face, color});
    }
    function fresh() {
      page = pdf.addPage([595.28, 841.89]);
      text(title + (draft ? ' - BOZZA' : ''), left, 797, 20, bold, accent);
      const identifiers = wrap('N. ' + number + '  |  Data ' + date(invoice.date), logo ? 370 : width, 10, bold);
      identifiers.forEach((s, i) => text(s, left, 775 - i * 14, 10, bold));
      if (logo) {
        const size = logo.scaleToFit(105, 55);
        page.drawImage(logo, {x: right - size.width, y: 815 - size.height, width: size.width, height: size.height});
      }
      y = Math.min(746, 758 - identifiers.length * 14);
      page.drawLine({start: {x: left, y}, end: {x: right, y}, thickness: .8, color: line});
      y -= 17; text(notice, left, y, 9, bold, accent); y -= 20;
    }
    function ensure(height) { if (y - height < bottom) { fresh(); return true; } return false; }
    function paragraph(value, size = 10, face = font, color = ink) {
      for (const s of wrap(value, width, size, face)) { ensure(size + 5); text(s, left, y, size, face, color); y -= size + 5; }
    }
    function heading(value) { ensure(45); y -= 8; paragraph(value, 10, bold, accent); y -= 3; }
    function partyLines(party) {
      return [party.name || '', party.address || '', [party.zip, party.city, party.province ? '(' + party.province + ')' : ''].filter(Boolean).join(' '),
        party.vat ? 'P. IVA: ' + party.vat : '', party.cf ? 'Codice fiscale: ' + party.cf : '',
        party.email ? 'Email: ' + party.email : '', party.phone ? 'Telefono: ' + party.phone : '',
        party.pec ? 'PEC: ' + party.pec : '', party.code ? 'Codice destinatario: ' + party.code : ''].filter(Boolean);
    }
    function parties() {
      const gap = 24, column = (width - gap) / 2;
      const sets = [partyLines(seller), partyLines(invoice.customer || {})].map(lines => lines.flatMap((s, i) => wrap(s, column - 18, i ? 9 : 11, i ? font : bold).map(t => ({text: t, size: i ? 9 : 11, face: i ? font : bold}))));
      let offset = 0, count = Math.max(1, ...sets.map(s => s.length));
      while (offset < count) {
        ensure(80);
        const chunk = Math.min(count - offset, Math.floor((y - bottom - 42) / 13));
        const height = chunk * 13 + 35;
        for (let index = 0; index < 2; index++) {
          const x = left + index * (column + gap);
          page.drawRectangle({x, y: y - height, width: column, height, color: pale});
          text(index ? 'CLIENTE' : 'EMITTENTE', x + 9, y - 17, 8, bold, accent);
          sets[index].slice(offset, offset + chunk).forEach((s, row) => text(s.text, x + 9, y - 35 - row * 13, s.size, s.face));
        }
        y -= height + 14; offset += chunk;
        if (offset < count) fresh();
      }
    }
    function table(headers, rows, widths, align = []) {
      const xs = widths.map((_, i) => left + widths.slice(0, i).reduce((sum, n) => sum + n, 0));
      const size = 9, rowStep = 13, padding = 6;
      function tableHeader() {
        const lines = headers.map((s, i) => wrap(s, widths[i] - 12, 8, bold));
        const height = Math.max(...lines.map(l => l.length)) * 11 + 15;
        ensure(height + 30);
        page.drawRectangle({x: left, y: y - height, width, height, color: pale});
        lines.forEach((column, i) => column.forEach((s, j) => text(s, xs[i] + 6, y - 13 - j * 11, 8, bold, accent)));
        y -= height;
      }
      tableHeader();
      for (const values of rows) {
        const lines = values.map((s, i) => wrap(s, widths[i] - 12, size));
        let offset = 0, count = Math.max(...lines.map(l => l.length));
        const needed = count * rowStep + padding * 2;
        if (needed <= 420 && y - needed < bottom) { fresh(); tableHeader(); }
        while (offset < count) {
          let available = Math.floor((y - bottom - padding * 2) / rowStep);
          if (available < 1) { fresh(); tableHeader(); available = Math.floor((y - bottom - padding * 2) / rowStep); }
          const chunk = Math.min(count - offset, available), height = chunk * rowStep + padding * 2;
          lines.forEach((column, i) => column.slice(offset, offset + chunk).forEach((s, j) => {
            const x = align[i] === 'right' ? xs[i] + widths[i] - 6 - font.widthOfTextAtSize(s, size) : xs[i] + 6;
            text(s, x, y - padding - size - j * rowStep, size);
          }));
          page.drawLine({start: {x: left, y: y - height}, end: {x: right, y: y - height}, thickness: .5, color: line});
          y -= height; offset += chunk;
          if (offset < count) { fresh(); tableHeader(); }
        }
      }
    }

    fresh(); parties();
    if (invoice.plate || invoice.km !== undefined && invoice.km !== '') {
      paragraph([invoice.plate ? 'Targa: ' + invoice.plate : '', invoice.km !== undefined && invoice.km !== '' ? 'Chilometraggio: ' + invoice.km + ' km' : ''].filter(Boolean).join('  |  '), 9);
      y -= 7;
    }
    if (invoice.reference) { paragraph('Fattura collegata: ' + invoice.reference + (invoice.referenceDate ? ' del ' + date(invoice.referenceDate) : ''), 9, bold); y -= 7; }
    const widths = [208, 37, 70, 36, 68, width - 419];
    table(['DESCRIZIONE', 'Q.TÀ', 'PREZZO NETTO €', 'SC. %', 'IVA / NATURA', 'TOTALE NETTO €'], totals.details.map(row => {
      const unitPrice = row.grossPrice == null ? Number(row.price) : Number(row.grossPrice) / (1 + Number(row.vat) / 100);
      return [row.description, quantity(row.quantity), unitMoney(unitPrice), Number(row.discount || 0) ? quantity(row.discount) : '-', Number(row.vat) ? quantity(row.vat) + '%' : '0% ' + (row.nature || ''), money(row.net)];
    }), widths, ['', 'right', 'right', 'right', '', 'right']);
    heading('RIEPILOGO IVA');
    table(['ALIQUOTA / NATURA', 'IMPONIBILE €', 'IVA €'], totals.summaries.map(group => {
      const references = [...new Set([group.reference, ...totals.details.filter(row => Number(row.vat) === Number(group.vat) && (row.nature || '') === (group.nature || '')).map(row => row.taxReference)].filter(Boolean))];
      const label = Number(group.vat) ? quantity(group.vat) + '%' : '0% ' + (group.nature || '');
      return [[label, ...references.map(reference => 'Rif. normativo: ' + reference)].join('\n'), money(group.net), money(group.tax)];
    }), [width - 220, 110, 110], ['', 'right', 'right']);
    const totalLines = [['Imponibile', totals.net], ['IVA', totals.tax], ...(rounding ? [['Arrotondamento', rounding]] : []), ...(stampDuty ? [['Bollo', stampDuty]] : []), ['TOTALE DOCUMENTO', total]];
    ensure(totalLines.length * 21 + 20); y -= 19;
    for (const [label, amount] of totalLines) {
      const last = label === 'TOTALE DOCUMENTO', size = last ? 12 : 10;
      text(label, right - 255, y, size, last ? bold : font, last ? accent : ink);
      const value = money(amount) + ' €'; text(value, right - (last ? bold : font).widthOfTextAtSize(value, size), y, size, last ? bold : font, last ? accent : ink); y -= 21;
    }
    heading('PAGAMENTO');
    const payments = {MP01: 'Contanti', MP02: 'Assegno', MP05: 'Bonifico', MP08: 'Carta di pagamento', MP12: 'RIBA', MP19: 'Addebito diretto SEPA'};
    paragraph('Modalità: ' + (payments[invoice.payment] || invoice.payment || 'Da definire'));
    if (invoice.iban || seller.iban) paragraph('IBAN: ' + (invoice.iban || seller.iban));
    if (invoice.paymentDue) paragraph('Scadenza: ' + date(invoice.paymentDue));
    paragraph((invoice.type === 'TD04' ? 'Stato rimborso: ' : 'Stato pagamento: ') + (invoice.paid ? (invoice.type === 'TD04' ? 'Rimborsata' : 'Saldata') + (invoice.paidDate ? ' il ' + date(invoice.paidDate) : '') : invoice.type === 'TD04' ? 'Da rimborsare / compensare' : 'Da saldare'));
    if (invoice.notes) { heading('NOTE'); paragraph(invoice.notes); }
    for (const [index, sheet] of pdf.getPages().entries()) {
      sheet.drawLine({start: {x: left, y: 47}, end: {x: right, y: 47}, thickness: .5, color: line});
      sheet.drawText(notice, {x: left, y: 33, font, size: 8, color: muted});
      const pageLabel = (index + 1) + ' / ' + pdf.getPageCount();
      sheet.drawText(pageLabel, {x: right - font.widthOfTextAtSize(pageLabel, 8), y: 33, font, size: 8, color: muted});
    }
    return pdf.save();
  }
  const api = {create};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorkshopInvoicePDF = api;
})(typeof window !== 'undefined' ? window : globalThis);
