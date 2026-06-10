const crypto = require('crypto');

class Keepz {
  constructor(rsaPublicKey, rsaPrivateKey) {
    // Expect Base64 DER encoded keys (no PEM headers)
    this.rsaPublicKey = rsaPublicKey;
    this.rsaPrivateKey = rsaPrivateKey;
  }

  /**
   * Encrypt data for sending to Keepz API
   * 1. Generate random AES-256 key (32 bytes) and IV (16 bytes)
   * 2. Encrypt JSON payload with AES-256-CBC
   * 3. Base64 encode AES key and IV, concatenate with dot: "base64Key.base64IV"
   * 4. Encrypt the concatenated string with Keepz's RSA public key (OAEP SHA-256)
   * 5. Base64 encode the RSA-encrypted result
   */
  encrypt(data) {
    // 1. Generate AES-256 key and IV
    const aesKey = crypto.randomBytes(32);
    const iv = crypto.randomBytes(16);

    // 2. Encrypt data with AES-256-CBC
    const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv);
    const encryptedData = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(data), 'utf8')),
      cipher.final(),
    ]);

    // 3. Prepare encryptedKeys (base64Key.base64IV)
    const encodedKey = aesKey.toString('base64');
    const encodedIV = iv.toString('base64');
    const concat = `${encodedKey}.${encodedIV}`;

    // 4. Encrypt with RSA public key (OAEP SHA-256)
    const rsaPublicKey = crypto.createPublicKey({
      key: Buffer.from(this.rsaPublicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });

    const encryptedKeys = crypto.publicEncrypt(
      {
        key: rsaPublicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(concat, 'utf8')
    );

    return {
      encryptedData: encryptedData.toString('base64'),
      encryptedKeys: encryptedKeys.toString('base64'),
    };
  }

  /**
   * Decrypt response from Keepz API
   * 1. Decrypt encryptedKeys with our RSA private key
   * 2. Split to get AES key and IV
   * 3. Decrypt encryptedData with AES-256-CBC
   */
  decrypt(encryptedDataB64, encryptedKeysB64) {
    const rsaPrivateKey = crypto.createPrivateKey({
      key: Buffer.from(this.rsaPrivateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });

    // 1. Decrypt the encryptedKeys
    const decryptedConcat = crypto
      .privateDecrypt(
        {
          key: rsaPrivateKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        Buffer.from(encryptedKeysB64, 'base64')
      )
      .toString('utf8');

    const [encodedKey, encodedIV] = decryptedConcat.split('.');
    const aesKey = Buffer.from(encodedKey, 'base64');
    const iv = Buffer.from(encodedIV, 'base64');

    // 2. Decrypt the encryptedData with AES
    const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
    const decryptedData = Buffer.concat([
      decipher.update(Buffer.from(encryptedDataB64, 'base64')),
      decipher.final(),
    ]);

    return JSON.parse(decryptedData.toString('utf8'));
  }
}

module.exports = Keepz;
