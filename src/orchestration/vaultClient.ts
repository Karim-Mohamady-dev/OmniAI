export async function storeKeyInServerVault(
  apiKey: string,
  existingRefId?: string
): Promise<{ refId: string; maskedKey: string }> {
  const res = await fetch('/api/vault/keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refId: existingRefId, apiKey }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to store credential in server vault.');
  }
  return { refId: data.refId, maskedKey: data.maskedKey };
}

export async function migrateLegacyKeysToVault(
  entries: Array<{ modelId: string; apiKey: string }>
): Promise<Array<{ modelId: string; refId: string; maskedKey: string }>> {
  const res = await fetch('/api/vault/migrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entries }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Failed to migrate credentials.');
  }
  return data.migrated || [];
}

export async function removeKeyFromServerVault(refId: string): Promise<void> {
  await fetch(`/api/vault/keys/${encodeURIComponent(refId)}`, { method: 'DELETE' });
}
