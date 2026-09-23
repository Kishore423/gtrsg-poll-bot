const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const {
  DEPLOYMENT_FILLS,
  buildDeploymentWorkbook,
  deploymentCellStyle,
  shiftCellText,
} = require('../src/deploymentWorkbook');

test('deployment shift text matches the roster layout', () => {
  assert.equal(shiftCellText('0730-1130 ; 1230-1630'), '0730-1130, 1230-1630');
  assert.equal(shiftCellText('Shift: 0730-1130 ; Shift: 1230-1630'), '0730-1130, 1230-1630');
  assert.equal(shiftCellText('8B ASSESSMENT 0730-1130'), '8B ASSESSMENT\n0730-1130');
  assert.equal(shiftCellText(''), null);
});

test('deployment duty categories use the reference colour palette', () => {
  assert.deepEqual(deploymentCellStyle(''), { category: 'empty', fill: DEPLOYMENT_FILLS.empty });
  assert.deepEqual(deploymentCellStyle('0730-1130, 1230-1630'), {
    category: 'regular', fill: DEPLOYMENT_FILLS.regular,
  });
  assert.deepEqual(deploymentCellStyle('0730-1230'), {
    category: 'shortDay', fill: DEPLOYMENT_FILLS.shortDay,
  });
  assert.deepEqual(deploymentCellStyle('OFF'), { category: 'off', fill: DEPLOYMENT_FILLS.off });
  assert.deepEqual(deploymentCellStyle('RD'), {
    category: 'restDay', fill: DEPLOYMENT_FILLS.restDay,
  });
  assert.deepEqual(deploymentCellStyle('1100-1500 / 9G'), {
    category: 'nineG', fill: DEPLOYMENT_FILLS.nineG,
  });
  assert.deepEqual(deploymentCellStyle('2000-0000'), {
    category: 'overnight', fill: DEPLOYMENT_FILLS.overnight,
  });
  assert.deepEqual(deploymentCellStyle('8B ASSESSMENT\n0730-1130'), {
    category: 'assessment', fill: DEPLOYMENT_FILLS.assessment,
  });
});

test('deployment workbook applies the weekly roster colours to each date cell', async () => {
  const dates = [
    '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27',
    '2026-08-28', '2026-08-29', '2026-08-30',
  ];
  const people = [{
    handle: '@alice',
    name: 'Alice',
    shifts: {
      '2026-08-24': 'Shift: 0730-1130 ; Shift: 1230-1630',
      '2026-08-25': '0730-1230',
      '2026-08-26': 'OFF',
      '2026-08-27': 'RD',
      '2026-08-28': '1100-1500 / 9G',
      '2026-08-29': '2000-0000',
      '2026-08-30': '8B ASSESSMENT 0730-1130',
    },
  }, {
    handle: '@bob',
    name: 'Bob',
    shifts: {},
  }];
  const buffer = await buildDeploymentWorkbook({
    dates,
    people,
    title: '8B_KR_NX Flexi - Deployment Sheet - 24 Aug 2026 to 30 Aug 2026',
    formatDate: (value) => value.slice(8),
  });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet('Deployment');

  assert.equal(
    sheet.getCell('A1').value,
    '8B_KR_NX Flexi - Deployment Sheet - 24 Aug 2026 to 30 Aug 2026'
  );
  assert.equal(sheet.getCell('A1').isMerged, true);
  assert.deepEqual(sheet.getRow(3).values.slice(1), [
    '@alice', 'Alice', '0730-1130, 1230-1630', '0730-1230', 'OFF', 'RD',
    '1100-1500 / 9G', '2000-0000', '8B ASSESSMENT\n0730-1130',
  ]);
  assert.deepEqual(
    ['C3', 'D3', 'E3', 'F3', 'G3', 'H3', 'I3'].map((address) =>
      sheet.getCell(address).fill.fgColor.argb),
    [
      DEPLOYMENT_FILLS.regular,
      DEPLOYMENT_FILLS.shortDay,
      DEPLOYMENT_FILLS.off,
      DEPLOYMENT_FILLS.restDay,
      DEPLOYMENT_FILLS.nineG,
      DEPLOYMENT_FILLS.overnight,
      DEPLOYMENT_FILLS.assessment,
    ]
  );
  assert.equal(sheet.getCell('C4').fill.fgColor.argb, DEPLOYMENT_FILLS.empty);
  assert.equal(sheet.views[0].xSplit, 2);
  assert.equal(sheet.views[0].ySplit, 2);
  assert.equal(sheet.getColumn(3).width, 27);
});
