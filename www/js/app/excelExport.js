/**
 * ============================================================================
 * HELPER COMPARTIDO: EXPORTACIÓN A EXCEL (.xls SpreadsheetML XML)
 * ============================================================================
 * Genera archivos .xls nativos compatibles con Microsoft Excel y LibreOffice
 * sin dependencias externas, respetando acentos UTF-8, columnas y tipos numéricos.
 */
(function (root) {
  'use strict';

  function escapeXml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function sanitizeSheetName(name) {
    const clean = String(name || 'Datos').replace(/[\\/?*[\]:]/g, ' ').trim();
    return (clean || 'Datos').slice(0, 31);
  }

  function buildSpreadsheetMl({ sheetName, headers = [], rows = [] }) {
    const safeSheet = escapeXml(sanitizeSheetName(sheetName));

    const headerCells = headers.map((h) => (
      `<Cell ss:StyleID="Header"><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`
    )).join('');

    const bodyRows = rows.map((row) => {
      const cells = (Array.isArray(row) ? row : []).map((val) => {
        if (typeof val === 'number' && Number.isFinite(val)) {
          return `<Cell><Data ss:Type="Number">${val}</Data></Cell>`;
        }
        if (val && typeof val === 'object' && typeof val.value === 'number' && Number.isFinite(val.value)) {
          const styleAttr = val.currency ? ' ss:StyleID="Currency"' : '';
          return `<Cell${styleAttr}><Data ss:Type="Number">${val.value}</Data></Cell>`;
        }
        return `<Cell><Data ss:Type="String">${escapeXml(val == null ? '' : val)}</Data></Cell>`;
      }).join('');
      return `<Row>${cells}</Row>`;
    }).join('\n');

    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<?mso-application progid="Excel.Sheet"?>',
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"',
      ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">',
      ' <Styles>',
      '  <Style ss:ID="Header">',
      '   <Font ss:Bold="1" ss:Color="#FFFFFF"/>',
      '   <Interior ss:Color="#1E293B" ss:Pattern="Solid"/>',
      '  </Style>',
      '  <Style ss:ID="Currency">',
      '   <NumberFormat ss:Format="$#,##0.00"/>',
      '  </Style>',
      ' </Styles>',
      ` <Worksheet ss:Name="${safeSheet}">`,
      '  <Table>',
      headers.length ? `   <Row>${headerCells}</Row>` : '',
      bodyRows,
      '  </Table>',
      ' </Worksheet>',
      '</Workbook>'
    ].join('\n');
  }

  function exportToExcel({ filename, sheetName = 'Reporte', headers = [], rows = [] }) {
    const xml = buildSpreadsheetMl({ sheetName, headers, rows });
    const baseName = String(filename || 'reporte').replace(/\.(csv|xlsx?)$/i, '');
    const fullName = `${baseName}.xls`;

    if (typeof root.document !== 'undefined' && typeof root.Blob === 'function') {
      const blob = new root.Blob(['\uFEFF' + xml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
      const url = root.URL.createObjectURL(blob);
      const a = root.document.createElement('a');
      a.href = url;
      a.download = fullName;
      root.document.body.appendChild(a);
      a.click();
      root.document.body.removeChild(a);
      setTimeout(() => root.URL.revokeObjectURL(url), 1000);
    }
    return { filename: fullName, content: xml };
  }

  root.buildSpreadsheetMl = buildSpreadsheetMl;
  root.exportToExcel = exportToExcel;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { buildSpreadsheetMl, exportToExcel };
  }
})(typeof window !== 'undefined' ? window : globalThis);
