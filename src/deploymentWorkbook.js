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
  return labels.map((label) => `Shift: ${label}`).join('\n');
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
  sheet.properties.defaultRowHeight = 54;

  sheet.columns = [
    { header: 'Telegram handle', key: 'handle', width: 20 },
    { header: 'Name', key: 'name', width: 34 },
    ...dates.map((date, index) => ({
      header: formatDate(date),
      key: `date_${index}`,
      width: 17,
    })),
  ];

  const header = sheet.getRow(1);
  header.height = 36;
  header.font = { name: 'Arial', size: 10, bold: true, color: { argb: 'FF17202A' } };
  header.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8F4F2' } };

  for (const person of people) {
    const rowValues = {
      handle: person.handle,
      name: person.name,
    };
    dates.forEach((date, index) => {
      rowValues[`date_${index}`] = shiftCellText(person.shifts[date]);
    });
    const row = sheet.addRow(rowValues);
    const maxLines = Math.max(1, ...dates.map((date) =>
      person.shifts[date] ? String(person.shifts[date]).split(' ; ').length : 0
    ));
    row.height = Math.min(120, Math.max(54, 18 + (maxLines * 16)));
  }

  sheet.eachRow((row, rowNumber) => {
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      cell.border = THIN_BORDER;
      if (rowNumber === 1) return;
      cell.font = {
        name: 'Arial',
        size: columnNumber <= 2 ? 10 : 9,
        bold: columnNumber > 2 && Boolean(cell.value),
        color: { argb: 'FF17202A' },
      };
      cell.alignment = {
        horizontal: columnNumber === 2 ? 'left' : 'center',
        vertical: 'middle',
        wrapText: true,
      };
    });
  });

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: 2 + dates.length },
  };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

module.exports = { buildDeploymentWorkbook, shiftCellText };
