import express from 'express';
import { getCryptoStatus } from '../crypto.ts';
import { getDatabaseUnavailableReason } from '../db/index.ts';
import {
  listVaultCredentialsForRequest,
  removeSecretFromVault,
  storeSecretInVault,
} from '../vault/secretVault.ts';

const router = express.Router();

router.use((req, res, next) => {
  const cryptoStatus = getCryptoStatus();
  if (!cryptoStatus.productionSafe) {
    res.status(503).json({
      error:
        'Server master encryption key is not configured for production credential storage. Set OMNIAI_MASTER_KEY or SESSION_SECRET.',
    });
    return;
  }
  if (req.authUser?.id) {
    const unavailable = getDatabaseUnavailableReason();
    if (unavailable) {
      res.status(503).json({ error: unavailable });
      return;
    }
  }
  next();
});

router.get('/status', async (req, res) => {
  try {
    const refs = await listVaultCredentialsForRequest(req);
    res.json({
      vaultActive: true,
      scopedToUser: Boolean(req.authUser?.id),
      storedCredentialCount: refs.length,
      credentials: refs,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Vault lookup failed.' });
  }
});

router.post('/keys', async (req, res) => {
  try {
    const { refId, apiKey, providerName } = req.body as {
      refId?: string;
      apiKey?: string;
      providerName?: string;
    };
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      res.status(400).json({ error: 'A non-empty apiKey string is required.' });
      return;
    }
    const stored = await storeSecretInVault(req, res, refId, apiKey, providerName);
    res.json({
      ok: true,
      refId: stored.refId,
      maskedKey: stored.maskedKey,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to store credential.' });
  }
});

router.post('/migrate', async (req, res) => {
  try {
    const { entries } = req.body as {
      entries?: Array<{ modelId: string; apiKey: string; providerName?: string }>;
    };
    if (!Array.isArray(entries)) {
      res.status(400).json({ error: 'entries array is required.' });
      return;
    }
    const migrated: Array<{ modelId: string; refId: string; maskedKey: string }> = [];
    for (const item of entries) {
      if (item.modelId && item.apiKey && item.apiKey.trim()) {
        const stored = await storeSecretInVault(req, res, undefined, item.apiKey, item.providerName);
        migrated.push({
          modelId: item.modelId,
          refId: stored.refId,
          maskedKey: stored.maskedKey,
        });
      }
    }
    res.json({ ok: true, migrated });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Migration failed.' });
  }
});

router.delete('/keys/:refId', async (req, res) => {
  try {
    const { refId } = req.params;
    if (refId) {
      await removeSecretFromVault(req, res, refId);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to remove credential.' });
  }
});

export default router;
