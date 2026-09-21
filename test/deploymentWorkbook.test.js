const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { buildDeploymentWorkbook } = require('../src/deploymentWorkbook');

test('deployment export marks only the last empty day RD and retains working shifts', async () => {
  const dates = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildDeploymentWorkbook({
    dates, formatDate: (date) => date,
    people: [
      { handle: '@mixed', name: 'Hidden name', shifts: { [dates[1]]: '0800-1200', [dates[3]]: '1200-1600' } },
      { handle: '@full', shifts: Object.fromEntries(dates.map((date) => [date, '0800-1200'])) },
      { handle: '@empty', shifts: {} },
    ],
  }));
  const sheet = workbook.getWorksheet('Deployment');
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['Telegram handle', 'Name', ...dates]);
  assert.deepEqual(sheet.getRow(2).values.slice(1), ['@mixed', 'Hidden name', 'OFF', '0800-1200', 'RD', '1200-1600']);
  assert.equal(sheet.getCell('C2').fill.fgColor.argb, 'FFE4D7F5');
  assert.equal(sheet.getCell('E2').fill.fgColor.argb, 'FF7030A0');
  assert.equal(sheet.getCell('E2').font.color.argb, 'FFFFFFFF');
  assert.ok(sheet.getRow(3).values.slice(3).every((value) => value === '0800-1200'));
  assert.deepEqual(sheet.getRow(4).values.slice(3), ['OFF', 'OFF', 'OFF', 'RD']);
  assert.equal(sheet.views[0].xSplit, 2);
  assert.equal(sheet.autoFilter, 'A1:F1');
});

test('deployment export preserves reference shift colours and plain comma-separated timings', async () => {
  const dates = ['a', 'b', 'c', 'd', 'e', 'f'];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildDeploymentWorkbook({
    dates, formatDate: (date) => date,
    people: [{ handle: '@staff', shifts: {
      a: '730-1230', b: '0730-1230 ; 1230-1630', c: '2000-0000',
      d: '0730-1230 ; 1230-1630 ; 2000-0000', e: '1230-1630', f: '0730-1230',
    } }],
  }));
  const sheet = workbook.getWorksheet('Deployment');
  assert.equal(sheet.getCell('A1').fill.fgColor.argb, 'FFD9D9D9');
  assert.equal(sheet.getCell('D2').value, '0730-1230, 1230-1630');
  for (const [cell, colour] of Object.entries({ C2: 'FFC6E0B4', D2: 'FF92D050', E2: 'FF9DC3E6', F2: 'FF9DC3E6', G2: 'FFC6E0B4', H2: 'FFC6E0B4' })) {
    assert.equal(sheet.getCell(cell).fill.fgColor.argb, colour);
  }
});
