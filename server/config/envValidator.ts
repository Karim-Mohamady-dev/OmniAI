export type EnvCheckSeverity = 'ok' | 'info' | 'warn' | 'error';

export interface EnvVariableReport {
  name: string;
  requiredInProduction: boolean;
  status: 'set' | 'missing' | 'placeholder' | 'invalid' | 'weak' | 'optional_unset';
  severity: EnvCheckSeverity;
  message: string;
}

export interface EnvironmentValidationReport {
  valid: boolean;
  strictProduction: boolean;
  isolatedTestHarness: boolean;
  nodeEnv: string;
  errors: string[];
  warnings: string[];
  checks: EnvVariableReport[];
}

const KNOWN_PLACEHOLDER_PATTERNS = [
  /^MY_GEMINI_API_KEY$/i,
  /^MY_APP_URL$/i,
  /^YOUR_GITHUB_CLIENT_ID$/i,
  /^YOUR_GITHUB_CLIENT_SECRET$/i,
  /^REPLACE_WITH_/i,
  /^YOUR_/i,
  /^changeme$/i,
  /^example$/i,
  /^secret$/i,
  /^password$/i,
  /^postgresql:\/\/user:password@localhost:5432\/omniai$/i,
];

export function isPlaceholderOrWeakSecret(value: string | undefined): boolean {
  const trimmed = (value || '').trim();
  if (!trimmed) return false;
  if (KNOWN_PLACEHOLDER_PATTERNS.some((re) => re.test(trimmed))) {
    return true;
  }
  return false;
}

export function isWeakEncryptionSecret(value: string | undefined): {
  weak: boolean;
  reason?: string;
} {
  const trimmed = (value || '').trim();
  if (!trimmed) {
    return { weak: true, reason: 'Not set.' };
  }
  if (isPlaceholderOrWeakSecret(trimmed)) {
    return { weak: true, reason: 'Uses a placeholder or insecure default value.' };
  }
  if (trimmed.length < 16) {
    return { weak: true, reason: `Length ${trimmed.length} is below minimum 16 characters (32+ recommended).` };
  }
  // Reject trivial single-character or repeating short patterns (e.g., "aaaaaaaaaaaaaaaa")
  const uniqueChars = new Set(trimmed.split('')).size;
  if (uniqueChars < 5) {
    return { weak: true, reason: 'Insufficient character entropy (too few distinct characters).' };
  }
  return { weak: false };
}

export function isValidDatabaseUrl(
  value: string | undefined,
  varName: string = 'DATABASE_URL'
): {
  valid: boolean;
  isPlaceholder: boolean;
  reason?: string;
} {
  const trimmed = (value || '').trim();
  if (!trimmed) {
    return { valid: false, isPlaceholder: false, reason: `${varName} is not set.` };
  }
  if (isPlaceholderOrWeakSecret(trimmed)) {
    return {
      valid: false,
      isPlaceholder: true,
      reason: `${varName} still uses the example placeholder connection string.`,
    };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
      return {
        valid: false,
        isPlaceholder: false,
        reason: `Unsupported ${varName} protocol "${parsed.protocol}" (expected postgresql:// or postgres://).`,
      };
    }
    if (!parsed.hostname) {
      return { valid: false, isPlaceholder: false, reason: `${varName} is missing a hostname.` };
    }
    return { valid: true, isPlaceholder: false };
  } catch {
    return {
      valid: false,
      isPlaceholder: false,
      reason: `${varName} is not a valid URL.`,
    };
  }
}

export function isValidAppUrl(value: string | undefined): {
  valid: boolean;
  isPlaceholder: boolean;
  isHttps: boolean;
  isLocalhost: boolean;
  normalized?: string;
  reason?: string;
} {
  const trimmed = (value || '').trim();
  if (!trimmed) {
    return {
      valid: false,
      isPlaceholder: false,
      isHttps: false,
      isLocalhost: false,
      reason: 'APP_URL is not set.',
    };
  }
  if (isPlaceholderOrWeakSecret(trimmed)) {
    return {
      valid: false,
      isPlaceholder: true,
      isHttps: false,
      isLocalhost: false,
      reason: 'APP_URL still uses the MY_APP_URL placeholder.',
    };
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        valid: false,
        isPlaceholder: false,
        isHttps: false,
        isLocalhost: false,
        reason: `APP_URL protocol must be http: or https: (got ${parsed.protocol}).`,
      };
    }
    const host = parsed.hostname.toLowerCase();
    const isLocalhost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    return {
      valid: true,
      isPlaceholder: false,
      isHttps: parsed.protocol === 'https:',
      isLocalhost,
      normalized: trimmed.replace(/\/+$/, ''),
    };
  } catch {
    return {
      valid: false,
      isPlaceholder: false,
      isHttps: false,
      isLocalhost: false,
      reason: 'APP_URL is not a valid URL.',
    };
  }
}

export function isIsolatedTestHarness(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OMNIAI_TEST_MEMORY_DB !== 'true') return false;
  if (env.OMNIAI_ISOLATED_TEST_HARNESS !== 'true') return false;
  const recognizedRunner =
    env.VITEST === 'true' ||
    env.NODE_TEST_CONTEXT !== undefined ||
    env.OMNIAI_TEST_RUNNER === 'playwright';
  if (!recognizedRunner) return false;
  if (env.APP_URL?.trim()) {
    const appCheck = isValidAppUrl(env.APP_URL);
    if (!appCheck.valid || !appCheck.isLocalhost) return false;
  }
  return true;
}

export function validateEnvironmentConfig(
  env: NodeJS.ProcessEnv = process.env
): EnvironmentValidationReport {
  const nodeEnv = (env.NODE_ENV || 'development').trim() || 'development';
  const isolatedTestHarness = isIsolatedTestHarness(env);
  const strictProduction = nodeEnv === 'production' && !isolatedTestHarness;
  const allowLocalFileDb = env.ALLOW_LOCAL_FILE_DB === 'true';

  const checks: EnvVariableReport[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. NODE_ENV
  checks.push({
    name: 'NODE_ENV',
    requiredInProduction: true,
    status: 'set',
    severity: 'ok',
    message: `Runtime mode is "${nodeEnv}".`,
  });

  if (nodeEnv === 'production' && env.OMNIAI_TEST_MEMORY_DB === 'true' && !isolatedTestHarness) {
    const msg =
      'In-memory test storage (OMNIAI_TEST_MEMORY_DB=true) is prohibited in production outside an isolated localhost test harness.';
    errors.push(`OMNIAI_TEST_MEMORY_DB: ${msg}`);
    checks.push({
      name: 'OMNIAI_TEST_MEMORY_DB',
      requiredInProduction: false,
      status: 'invalid',
      severity: 'error',
      message: msg,
    });
  }

  // 2. APP_URL
  const appUrlCheck = isValidAppUrl(env.APP_URL);
  if (!appUrlCheck.valid) {
    const msg = appUrlCheck.reason || 'APP_URL is invalid.';
    if (strictProduction) {
      errors.push(`APP_URL: ${msg}`);
    } else {
      warnings.push(`APP_URL: ${msg} (defaults to http://localhost:3000 in dev).`);
    }
    checks.push({
      name: 'APP_URL',
      requiredInProduction: true,
      status: appUrlCheck.isPlaceholder ? 'placeholder' : env.APP_URL?.trim() ? 'invalid' : 'missing',
      severity: strictProduction ? 'error' : 'warn',
      message: msg,
    });
  } else if (strictProduction && !appUrlCheck.isHttps && !appUrlCheck.isLocalhost) {
    const msg = 'APP_URL uses HTTP instead of HTTPS in production; OAuth and Secure cookies require HTTPS.';
    warnings.push(`APP_URL: ${msg}`);
    checks.push({
      name: 'APP_URL',
      requiredInProduction: true,
      status: 'set',
      severity: 'warn',
      message: msg,
    });
  } else {
    checks.push({
      name: 'APP_URL',
      requiredInProduction: true,
      status: 'set',
      severity: 'ok',
      message: `Configured (${appUrlCheck.normalized}).`,
    });
  }

  // 3. DATABASE_URL & DATABASE_SSL
  const dbCheck = isValidDatabaseUrl(env.DATABASE_URL);
  if (dbCheck.valid) {
    checks.push({
      name: 'DATABASE_URL',
      requiredInProduction: !allowLocalFileDb,
      status: 'set',
      severity: 'ok',
      message: 'Valid PostgreSQL connection string format.',
    });
  } else {
    const isRequiredNow = strictProduction && !allowLocalFileDb;
    const msg = dbCheck.reason || 'PostgreSQL DATABASE_URL is not configured.';
    if (isRequiredNow) {
      errors.push(`DATABASE_URL: ${msg} Set DATABASE_URL or ALLOW_LOCAL_FILE_DB=true.`);
    } else {
      warnings.push(`DATABASE_URL: ${msg}`);
    }
    checks.push({
      name: 'DATABASE_URL',
      requiredInProduction: !allowLocalFileDb,
      status: dbCheck.isPlaceholder ? 'placeholder' : env.DATABASE_URL?.trim() ? 'invalid' : 'missing',
      severity: isRequiredNow ? 'error' : 'warn',
      message: msg,
    });
  }

  const dbSsl = (env.DATABASE_SSL || '').trim().toLowerCase();
  checks.push({
    name: 'DATABASE_SSL',
    requiredInProduction: false,
    status: dbSsl === 'true' || dbSsl === 'require' ? 'set' : 'optional_unset',
    severity: 'info',
    message:
      dbSsl === 'true' || dbSsl === 'require'
        ? 'TLS/SSL enabled for PostgreSQL pool.'
        : 'PostgreSQL SSL disabled (enable for managed cloud databases).',
  });

  // 4. OMNIAI_MASTER_KEY & SESSION_SECRET
  const masterRaw = env.OMNIAI_MASTER_KEY?.trim();
  const sessionRaw = env.SESSION_SECRET?.trim();
  const geminiRaw = env.GEMINI_API_KEY?.trim();

  const effectiveMaster = masterRaw || sessionRaw;
  const masterWeak = isWeakEncryptionSecret(effectiveMaster);
  const reusedGemini = Boolean(
    effectiveMaster && geminiRaw && !isPlaceholderOrWeakSecret(geminiRaw) && effectiveMaster === geminiRaw
  );

  if (reusedGemini) {
    const msg = 'Encryption key must never reuse GEMINI_API_KEY.';
    errors.push(`OMNIAI_MASTER_KEY: ${msg}`);
    checks.push({
      name: 'OMNIAI_MASTER_KEY',
      requiredInProduction: true,
      status: 'invalid',
      severity: 'error',
      message: msg,
    });
  } else if (masterWeak.weak) {
    const msg = masterWeak.reason || 'OMNIAI_MASTER_KEY is weak or missing.';
    if (nodeEnv === 'production') {
      errors.push(`OMNIAI_MASTER_KEY: ${msg}`);
    } else {
      warnings.push(`OMNIAI_MASTER_KEY: ${msg} (using ephemeral dev key outside production).`);
    }
    checks.push({
      name: 'OMNIAI_MASTER_KEY',
      requiredInProduction: true,
      status: !effectiveMaster
        ? 'missing'
        : isPlaceholderOrWeakSecret(effectiveMaster)
          ? 'placeholder'
          : 'weak',
      severity: nodeEnv === 'production' ? 'error' : 'warn',
      message: msg,
    });
  } else {
    const recommendedLengthWarn = (effectiveMaster?.length || 0) < 32;
    if (recommendedLengthWarn) {
      warnings.push('OMNIAI_MASTER_KEY: Configured (>= 16 chars), 32+ chars recommended for production.');
    }
    checks.push({
      name: 'OMNIAI_MASTER_KEY',
      requiredInProduction: true,
      status: 'set',
      severity: recommendedLengthWarn ? 'warn' : 'ok',
      message: recommendedLengthWarn
        ? 'Configured (16–31 chars; 32+ chars recommended).'
        : 'Strong encryption key configured (32+ chars).',
    });
  }

  if (sessionRaw) {
    const sWeak = isWeakEncryptionSecret(sessionRaw);
    if (sWeak.weak && nodeEnv === 'production') {
      errors.push(`SESSION_SECRET: ${sWeak.reason}`);
    }
    checks.push({
      name: 'SESSION_SECRET',
      requiredInProduction: false,
      status: sWeak.weak ? (isPlaceholderOrWeakSecret(sessionRaw) ? 'placeholder' : 'weak') : 'set',
      severity: sWeak.weak ? (nodeEnv === 'production' ? 'error' : 'warn') : 'ok',
      message: sWeak.weak ? sWeak.reason || 'Weak SESSION_SECRET.' : 'Configured.',
    });
  } else {
    checks.push({
      name: 'SESSION_SECRET',
      requiredInProduction: false,
      status: 'optional_unset',
      severity: 'info',
      message: masterWeak.weak
        ? 'Not set (falls back to OMNIAI_MASTER_KEY if configured).'
        : 'Not set separately (using OMNIAI_MASTER_KEY).',
    });
  }

  // 5. Optional AI Provider Keys
  for (const keyName of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY'] as const) {
    const val = env[keyName]?.trim();
    if (!val) {
      checks.push({
        name: keyName,
        requiredInProduction: false,
        status: 'optional_unset',
        severity: 'info',
        message: 'Optional server key not set (users can configure keys via encrypted vault).',
      });
    } else if (isPlaceholderOrWeakSecret(val)) {
      warnings.push(`${keyName}: Contains template placeholder value; treated as unconfigured.`);
      checks.push({
        name: keyName,
        requiredInProduction: false,
        status: 'placeholder',
        severity: 'warn',
        message: 'Placeholder value detected; replace with real key or leave unset.',
      });
    } else {
      checks.push({
        name: keyName,
        requiredInProduction: false,
        status: 'set',
        severity: 'ok',
        message: 'Configured (value redacted).',
      });
    }
  }

  // 6. Optional GitHub OAuth Credentials
  const ghId = env.GITHUB_CLIENT_ID?.trim();
  const ghSecret = env.GITHUB_CLIENT_SECRET?.trim();
  const ghIdPlaceholder = isPlaceholderOrWeakSecret(ghId);
  const ghSecretPlaceholder = isPlaceholderOrWeakSecret(ghSecret);
  const ghIdReal = Boolean(ghId && !ghIdPlaceholder);
  const ghSecretReal = Boolean(ghSecret && !ghSecretPlaceholder);

  if (ghIdReal && ghSecretReal) {
    checks.push({
      name: 'GITHUB_CLIENT_ID',
      requiredInProduction: false,
      status: 'set',
      severity: 'ok',
      message: 'Configured (value redacted).',
    });
    checks.push({
      name: 'GITHUB_CLIENT_SECRET',
      requiredInProduction: false,
      status: 'set',
      severity: 'ok',
      message: 'Configured (value redacted).',
    });
  } else if ((ghIdReal && !ghSecretReal) || (!ghIdReal && ghSecretReal)) {
    const msg = 'Partial GitHub OAuth configuration: both GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required.';
    warnings.push(msg);
    checks.push({
      name: 'GITHUB_CLIENT_ID',
      requiredInProduction: false,
      status: ghIdReal ? 'set' : ghIdPlaceholder ? 'placeholder' : 'missing',
      severity: ghIdReal ? 'ok' : 'warn',
      message: ghIdReal ? 'Configured.' : msg,
    });
    checks.push({
      name: 'GITHUB_CLIENT_SECRET',
      requiredInProduction: false,
      status: ghSecretReal ? 'set' : ghSecretPlaceholder ? 'placeholder' : 'missing',
      severity: ghSecretReal ? 'ok' : 'warn',
      message: ghSecretReal ? 'Configured.' : msg,
    });
  } else {
    checks.push({
      name: 'GITHUB_CLIENT_ID',
      requiredInProduction: false,
      status: ghIdPlaceholder ? 'placeholder' : 'optional_unset',
      severity: ghIdPlaceholder ? 'warn' : 'info',
      message: ghIdPlaceholder
        ? 'Placeholder detected; GitHub OAuth disabled until replaced.'
        : 'Optional GitHub OAuth not configured.',
    });
    checks.push({
      name: 'GITHUB_CLIENT_SECRET',
      requiredInProduction: false,
      status: ghSecretPlaceholder ? 'placeholder' : 'optional_unset',
      severity: ghSecretPlaceholder ? 'warn' : 'info',
      message: ghSecretPlaceholder
        ? 'Placeholder detected; GitHub OAuth disabled until replaced.'
        : 'Optional GitHub OAuth not configured.',
    });
  }

  return {
    valid: errors.length === 0,
    strictProduction,
    isolatedTestHarness,
    nodeEnv,
    errors,
    warnings,
    checks,
  };
}
