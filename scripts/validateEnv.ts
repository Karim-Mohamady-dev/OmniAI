import dotenv from 'dotenv';
import { validateEnvironmentConfig } from '../server/config/envValidator.ts';
import { getCryptoStatus } from '../server/crypto.ts';

dotenv.config();

function main() {
  const args = process.argv.slice(2);
  const strictFlag = args.includes('--production') || args.includes('--strict');
  const jsonFlag = args.includes('--json');

  const envSnapshot: NodeJS.ProcessEnv = strictFlag
    ? { ...process.env, NODE_ENV: 'production' }
    : process.env;

  const report = validateEnvironmentConfig(envSnapshot);
  const cryptoStatus = getCryptoStatus();

  if (jsonFlag) {
    console.log(
      JSON.stringify(
        {
          ...report,
          crypto: cryptoStatus,
        },
        null,
        2
      )
    );
    if (!report.valid) process.exitCode = 1;
    return;
  }

  console.log('\n=== OmniAI Studio Environment Configuration Diagnostic ===');
  console.log(`Mode             : ${report.nodeEnv}${report.strictProduction ? ' (strict production)' : ''}`);
  console.log(`Validation Status: ${report.valid ? 'VALID' : 'INVALID'}`);
  console.log(`Crypto Source    : ${cryptoStatus.source} (productionSafe=${cryptoStatus.productionSafe})`);
  console.log('');

  for (const check of report.checks) {
    const tag =
      check.severity === 'error'
        ? '[ERROR]'
        : check.severity === 'warn'
          ? '[WARN] '
          : check.severity === 'ok'
            ? '[OK]   '
            : '[INFO] ';
    console.log(`${tag} ${check.name.padEnd(22)} | ${check.status.padEnd(14)} | ${check.message}`);
  }

  if (report.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of report.warnings) {
      console.log(`  - ${w}`);
    }
  }

  if (report.errors.length > 0) {
    console.log('\nBlocking Configuration Errors:');
    for (const e of report.errors) {
      console.log(`  - ${e}`);
    }
    process.exitCode = 1;
  }
}

main();
