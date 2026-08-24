export async function publishCredentialEnvelope(fsOperations, finalPath, temporaryPath, source) {
  let published = false;
  try {
    await fsOperations.writeFile(temporaryPath, source, { mode: 0o600, flag: 'wx' });
    await fsOperations.rename(temporaryPath, finalPath);
    published = true;
  } finally {
    if (!published) {
      await fsOperations.unlink(temporaryPath).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
  }
}

export async function removeCredentialEnvelope(fsOperations, finalPath) {
  try {
    await fsOperations.unlink(finalPath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
