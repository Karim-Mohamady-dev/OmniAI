import dotenv from 'dotenv';
import { isValidAppUrl } from '../server/config/envValidator.ts';
import { sanitizeSecretFromText } from '../server/vault/secretVault.ts';

dotenv.config();

async function main() {
  const clientId = process.env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_CLIENT_SECRET?.trim();
  const testToken = process.env.GITHUB_TEST_TOKEN?.trim();

  const appUrlCheck = isValidAppUrl(process.env.APP_URL);
  const baseUrl = appUrlCheck.valid && appUrlCheck.normalized ? appUrlCheck.normalized : 'http://localhost:3000';
  const callbackUrl = `${baseUrl}/auth/callback`;

  const oauthConfigured = Boolean(
    clientId &&
      clientSecret &&
      clientId !== 'YOUR_GITHUB_CLIENT_ID' &&
      clientSecret !== 'YOUR_GITHUB_CLIENT_SECRET'
  );

  console.log('\n=== OmniAI GitHub OAuth & Live API Verification ===');
  console.log(`APP_URL Valid : ${appUrlCheck.valid ? `YES (${baseUrl})` : `NO (${appUrlCheck.reason || 'unset'})`}`);
  console.log(`Callback URL  : ${callbackUrl}`);
  console.log(`OAuth Env     : ${oauthConfigured ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
  console.log(`Test Token    : ${testToken ? 'CONFIGURED' : 'NOT CONFIGURED'}`);

  if (!oauthConfigured && !testToken) {
    console.log('[NOT CONFIGURED] Live GitHub OAuth requires GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.');
    console.log('\nExact GitHub OAuth App Setup Instructions:');
    console.log('  1. Open https://github.com/settings/developers -> "OAuth Apps" -> "New OAuth App".');
    console.log('  2. Application name: OmniAI Studio');
    console.log(`  3. Homepage URL: ${baseUrl}`);
    console.log(`  4. Authorization callback URL: ${callbackUrl}`);
    console.log('  5. Copy Client ID and generate Client Secret, then set GITHUB_CLIENT_ID & GITHUB_CLIENT_SECRET.');
    console.log('  6. Restart OmniAI Studio, click "Connect GitHub", approve scopes, and verify repo list/commit/push/pull/disconnect.');
    return;
  }

  if (oauthConfigured) {
    const authParams = new URLSearchParams({
      client_id: clientId!,
      redirect_uri: callbackUrl,
      scope: 'repo read:user user:email',
      state: 'probe_state_validation',
    });
    const authUrl = `https://github.com/login/oauth/authorize?${authParams.toString()}`;
    console.log(`[PASS] Constructed GitHub OAuth authorize URL for callback ${callbackUrl}`);
    console.log(`       Authorize endpoint host=${new URL(authUrl).host}, scopes=repo,read:user,user:email`);
  }

  if (testToken) {
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${testToken}`,
        'User-Agent': 'OmniAI-Studio-Verify',
      },
    });
    if (!userRes.ok) {
      console.error(`[FAIL] Live GitHub /user returned HTTP ${userRes.status}`);
      process.exitCode = 1;
      return;
    }
    const user = (await userRes.json()) as { login: string; public_repos: number };
    const reposRes = await fetch('https://api.github.com/user/repos?per_page=3&sort=updated', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${testToken}`,
        'User-Agent': 'OmniAI-Studio-Verify',
      },
    });
    const reposJson = reposRes.ok ? ((await reposRes.json()) as Array<{ full_name: string }>) : [];
    console.log(
      `[REAL PASS] Authenticated live GitHub user: ${user.login} (public_repos=${user.public_repos}, sample_repos=${reposJson.length})`
    );
  }

  console.log('\nInteractive OAuth Browser Checklist (requires live user browser session):');
  console.log('  - [NOT RUN - INTERACTIVE] GitHub OAuth sign-in & /auth/callback exchange');
  console.log('  - [NOT RUN - INTERACTIVE] Authenticated repository listing in UI');
  console.log('  - [NOT RUN - INTERACTIVE] Commit, push, pull sync, disconnect & encrypted DB token check');
}

main().catch((err) => {
  console.error('GitHub live check error:', sanitizeSecretFromText(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
