/**
 * CLI tool to compute TikTok Content Live & TikTok Content Video metrics
 * across all folders in Reports/{seller_id}_{period}/ and write summary Excel files.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const {
  classifyReportFilename,
  aggregateReportEntries,
  buildWorkbookFromSummaryData
} = require('./report-calculator.js');

const REPORTS_DIR = path.join(__dirname, 'Reports');

function inflateRawNode(compressedBytes) {
  return zlib.inflateRawSync(compressedBytes);
}

function parseFolderSellerAndPeriod(folderName) {
  const sepIdx = folderName.lastIndexOf('_');
  if (sepIdx <= 0) {
    return { sellerId: folderName, period: '' };
  }
  return {
    sellerId: folderName.slice(0, sepIdx),
    period: folderName.slice(sepIdx + 1)
  };
}

async function processReportFolder(folderPath, folderName) {
  const { sellerId, period } = parseFolderSellerAndPeriod(folderName);
  const fileNames = fs
    .readdirSync(folderPath)
    .filter((name) => classifyReportFilename(name) !== null)
    .sort();

  const fileEntries = fileNames.map((fileName) => ({
    fileName,
    contentKey: classifyReportFilename(fileName),
    bytes: new Uint8Array(fs.readFileSync(path.join(folderPath, fileName)))
  }));

  return aggregateReportEntries(sellerId, period, fileEntries, inflateRawNode);
}

async function main() {
  if (!fs.existsSync(REPORTS_DIR)) {
    console.error(`Reports directory not found: ${REPORTS_DIR}`);
    process.exit(1);
  }

  const subdirs = fs
    .readdirSync(REPORTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  if (subdirs.length === 0) {
    console.log('No report folders found inside Reports/.');
    return;
  }

  const allSummaryRows = [];
  const allBreakdownRows = [];

  for (const folderName of subdirs) {
    const folderPath = path.join(REPORTS_DIR, folderName);
    const { summaryRows, breakdownRows } = await processReportFolder(folderPath, folderName);

    if (breakdownRows.length === 0) {
      continue;
    }

    const folderWorkbook = buildWorkbookFromSummaryData(summaryRows, breakdownRows);
    const folderOutPath = path.join(folderPath, `Summary_${folderName}.xlsx`);
    fs.writeFileSync(folderOutPath, folderWorkbook);

    allSummaryRows.push(...summaryRows);
    allBreakdownRows.push(...breakdownRows);

    console.log(`\n=== ${folderName} ===`);
    for (const row of summaryRows) {
      console.log(
        `  ${row.contentType.padEnd(22)} | revenue=${row.revenue.toFixed(2).padStart(10)} | product_impression=${String(row.product_impression).padStart(10)} | impression=${String(row.impression).padStart(10)} | files=[${row.filesIncluded}]`
      );
    }
    console.log(`  -> Saved: ${folderOutPath}`);
  }

  if (allSummaryRows.length > 0) {
    const masterOutPath = path.join(REPORTS_DIR, 'Summary_Calculation.xlsx');
    const masterWorkbook = buildWorkbookFromSummaryData(allSummaryRows, allBreakdownRows);
    fs.writeFileSync(masterOutPath, masterWorkbook);
    console.log(`\nMaster summary saved: ${masterOutPath}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Error processing reports:', err);
    process.exit(1);
  });
}
