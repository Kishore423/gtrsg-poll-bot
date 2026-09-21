const ExcelJS = require('exceljs');

const THIN_BORDER = {
  top: { style: 'thin', color: { argb: 'FF1F2937' } },
  left: { style: 'thin', color: { argb: 'FF1F2937' } },
  bottom: { style: 'thin', color: { argb: 'FF1F2937' } },
  right: { style: 'thin', color: { argb: 'FF1F2937' } },
};

function shiftCellText(value) {
  const labels = String(value || '')
    .split(' ; ')
    .filter(Boolean);
  if (!labels.length) return null;
  return labels.join(', ');
}

function shiftCellColor(value) {
  if (value === 'OFF') return 'FFE4D7F5';
  if (value === 'RD') return 'FF7030A0';
  const times = String(value || '').replace(/:/g, '').match(/\d{3,4}-\d{3,4}/g) || [];
  const normalized = times.map((time) => time.split('-').map((part) => part.padStart(4, '0')).join('-'));
  if (normalized.includes('2000-0000')) return 'FF9DC3E6';
  const dayShifts = new Set(normalized.filter((time) => ['0730-1230', '1230-1630'].includes(time)));
  if (dayShifts.size === 2) return 'FF92D050';
  if (dayShifts.size === 1) return 'FFC6E0B4';
  return null;
}

async function buildDeploymentWorkbook({ dates, people, formatDate }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Gops poll';
  workbook.subject = 'Confirmed Telegram poll deployments';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Deployment', {
    views: [{ state: 'frozen', xSplit: 2, ySplit: 1 }],
    pageSetup: {
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      paperSize: 9,
      margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 },
    },
  });
  sheet.pageSetup.printTitlesRow = '1:1';
  sheet.properties.defaultRowHeight = 36;

  sheet.columns = [
    { header: 'Telegram handle', key: 'handle', width: 20 },
    { header: 'Name', key: 'name', width: 34 },
    ...dates.map((date, index) => ({
      header: formatDate(date),
      key: `date_${index}`,
      width: 27,
    })),
  ];

  const header = sheet.getRow(1);
  header.height = 36;
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
      person.shifts[date] ? String(person.shifts[date]).split(' ; ').length : 0
    ));
    row.height = Math.min(120, Math.max(36, 18 + (Math.ceil(maxLines / 2) * 16)));
  }

  sheet.eachRow((row, rowNumber) => {
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      cell.border = THIN_BORDER;
      if (rowNumber === 1) return;
      cell.font = {
        name: 'Arial',
        size: columnNumber <= 2 ? 10 : 9,
        bold: columnNumber > 2 && Boolean(cell.value),
        color: { argb: columnNumber > 2 && cell.value === 'RD' ? 'FFFFFFFF' : 'FF17202A' },
      };
      const fillColor = columnNumber > 2 ? shiftCellColor(cell.value) : null;
      if (fillColor) {
        cell.fill = {
          type: 'pattern', pattern: 'solid',
          fgColor: { argb: fillColor },
        };
      }
      cell.alignment = {
        horizontal: 'center',
        vertical: 'middle',
        wrapText: true,
      };
    });
  });

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: 2 + dates.length },
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
    swatch.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: shiftCellColor(label) } };
    swatch.border = THIN_BORDER;
    swatch.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    swatch.font = { name: 'Arial', size: 9, bold: true, color: { argb: label === 'RD' ? 'FFFFFFFF' : 'FF17202A' } };
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

module.exports = { buildDeploymentWorkbook, shiftCellText };
