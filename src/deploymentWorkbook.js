const ExcelJS = require('exceljs');

const THIN_BORDER = {
  top: { style: 'thin', color: { argb: 'FF1F2937' } },
  left: { style: 'thin', color: { argb: 'FF1F2937' } },
  bottom: { style: 'thin', color: { argb: 'FF1F2937' } },
  right: { style: 'thin', color: { argb: 'FF1F2937' } },
};

const DEPLOYMENT_FILLS = Object.freeze({
  empty: 'FFA6A6A6',
  regular: 'FF92D050',
  shortDay: 'FFC6E0B4',
  off: 'FFE4D7F5',
  restDay: 'FF7030A0',
  nineG: 'FFF4B183',
  overnight: 'FF9DC3E6',
  assessment: 'FFFFD966',
});

function shiftCellText(value) {
  const labels = String(value || '')
    .split(' ; ')
    .map((label) => label.trim().replace(/^shift\s*:\s*/i, '').trim())
    .filter(Boolean);
  if (!labels.length) return null;
  const text = labels.join(', ');
  if (/assessment/i.test(text) && !text.includes('\n')) {
    return text.replace(/\s+(?=\d{4}\s*-\s*\d{4})/, '\n');
  }
  return text;
}

function deploymentCellStyle(value) {
  const text = String(value || '').trim();
  const normalized = text.replace(/\s+/g, ' ').toUpperCase();
  if (!normalized) return { category: 'empty', fill: DEPLOYMENT_FILLS.empty };
  if (/^RD$/.test(normalized)) {
    return { category: 'restDay', fill: DEPLOYMENT_FILLS.restDay };
  }
  if (/^OFF$/.test(normalized)) {
    return { category: 'off', fill: DEPLOYMENT_FILLS.off };
  }
  if (/ASSESSMENT/.test(normalized)) {
    return { category: 'assessment', fill: DEPLOYMENT_FILLS.assessment };
  }
  if (/(^|[^A-Z0-9])9G([^A-Z0-9]|$)/.test(normalized)) {
    return { category: 'nineG', fill: DEPLOYMENT_FILLS.nineG };
  }
  if (/(^|[,\s])20\d{2}\s*-\s*(?:00|0[0-6])\d{2}/.test(normalized)) {
    return { category: 'overnight', fill: DEPLOYMENT_FILLS.overnight };
  }
  if (/^0730\s*-\s*1230$/.test(normalized)) {
    return { category: 'shortDay', fill: DEPLOYMENT_FILLS.shortDay };
  }
  return { category: 'regular', fill: DEPLOYMENT_FILLS.regular };
}

async function buildDeploymentWorkbook({ dates, people, formatDate, title = 'Deployment Sheet' }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Gops poll';
  workbook.subject = 'Confirmed Telegram poll deployments';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Deployment', {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 2 }],
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9,
      margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });
  sheet.views[0].showGridLines = false;
  sheet.pageSetup.printTitlesRow = '1:2';
  sheet.properties.defaultRowHeight = 36;

  sheet.columns = [
    { key: 'handle', width: 20 },
    { key: 'name', width: 34 },
    ...dates.map((date, index) => ({
      key: `date_${index}`,
      width: 27,
    })),
  ];

  const finalColumn = 2 + dates.length;
  sheet.mergeCells(1, 1, 1, finalColumn);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FF17202A' } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).height = 40;

  const header = sheet.getRow(2);
  header.values = ['Telegram handle', 'Name', ...dates.map(formatDate)];
  header.height = 34;
  header.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF17202A' } };
  header.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9D9D9' } };

  for (const person of people) {
    const rowValues = {
      handle: person.handle,
      name: person.name || '',
    };
    const shiftTexts = dates.map((date) => shiftCellText(person.shifts[date]));
    const lastOffIndex = shiftTexts.lastIndexOf(null);
    dates.forEach((date, index) => {
      rowValues[`date_${index}`] = shiftTexts[index] || (index === lastOffIndex ? 'RD' : 'OFF');
    });
    const row = sheet.addRow(rowValues);
    const maxLines = Math.max(1, ...dates.map((date) =>
      shiftCellText(person.shifts[date])?.split('\n').length || 0
    ));
    row.height = Math.min(120, Math.max(36, 18 + (Math.ceil(maxLines / 2) * 16)));
  }

  sheet.eachRow((row, rowNumber) => {
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      cell.border = THIN_BORDER;
      if (rowNumber <= 2) return;
      if (columnNumber > 2) {
        const style = deploymentCellStyle(cell.value);
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: style.fill },
        };
      } else {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFFFFFFF' },
        };
      }
      cell.font = {
        name: 'Arial',
        size: columnNumber <= 2 ? 10 : 9,
        bold: columnNumber > 2 && Boolean(cell.value),
        color: { argb: columnNumber > 2 && cell.value === 'RD' ? 'FFFFFFFF' : 'FF17202A' },
      };
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
    });
  });

  sheet.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: 2, column: finalColumn },
  };

  sheet.addRow([]).height = 12;
  const legendTitle = sheet.addRow(['Colour legend']);
  legendTitle.height = 24;
  legendTitle.font = { name: 'Arial', size: 10, bold: true };
  const legend = [
    ['0730-1230', 'One day shift: 0730-1230 or 1230-1630'],
    ['0730-1230, 1230-1630', 'Two day shifts: 0730-1230 and 1230-1630'],
    ['2000-0000', 'Night shift, alone or with daytime shifts'],
    ['OFF', 'Off day'],
    ['RD', 'Rest day'],
  ];
  for (const [label, description] of legend) {
    const row = sheet.addRow([label, description]);
    row.height = 34;
    if (dates.length > 1) sheet.mergeCells(row.number, 2, row.number, Math.min(4, dates.length + 1));
    row.font = { name: 'Arial', size: 10, color: { argb: 'FF17202A' } };
    row.alignment = { vertical: 'middle', wrapText: true };
    const swatch = row.getCell(1);
    swatch.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: deploymentCellStyle(label).fill } };
    swatch.border = THIN_BORDER;
    swatch.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    swatch.font = { name: 'Arial', size: 9, bold: true, color: { argb: label === 'RD' ? 'FFFFFFFF' : 'FF17202A' } };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

module.exports = {
  DEPLOYMENT_FILLS,
  buildDeploymentWorkbook,
  deploymentCellStyle,
  shiftCellText,
};
