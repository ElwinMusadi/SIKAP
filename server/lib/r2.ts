// R2 helpers shared by the photo and document upload paths.

/**
 * Compensation after a failed DB batch (M2): delete the freshly stored object ONLY
 * if no committed row references it. A batch can fail on the client side (timeout,
 * network) after D1 already committed it; deleting then would leave a row pointing
 * at a missing file. `referenced` must return a row when the key is in use.
 * Never throws: on any failure the object is kept and reported as a possible orphan
 * (harmless; never served, can be swept later).
 */
export async function deleteUnreferencedObject(
  bucket: R2Bucket,
  key: string,
  referenced: D1PreparedStatement,
): Promise<'deleted' | 'kept' | 'orphan'> {
  try {
    if (await referenced.first()) return 'kept';
  } catch (err) {
    console.error('orphan r2 object', key, err);
    return 'orphan';
  }
  try {
    await bucket.delete(key);
    return 'deleted';
  } catch (err) {
    console.error('orphan r2 object', key, err);
    return 'orphan';
  }
}
