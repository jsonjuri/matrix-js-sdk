/*
Copyright 2018 New Vector Ltd
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/**
 * QR code key verification.
 * @module crypto/verification/QRCode
 */

import {VerificationBase as Base} from "./Base";
import {
    newKeyMismatchError,
    newUserCancelledError,
} from './Error';
import {encodeUnpaddedBase64, decodeBase64} from "../olmlib";

export const SHOW_QR_CODE_METHOD = "m.qr_code.show.v1";
export const SCAN_QR_CODE_METHOD = "m.qr_code.scan.v1";

/**
 * @class crypto/verification/QRCode/ReciprocateQRCode
 * @extends {module:crypto/verification/Base}
 */
export class ReciprocateQRCode extends Base {
    static factory(...args) {
        return new ReciprocateQRCode(...args);
    }

    static get NAME() {
        return "m.reciprocate.v1";
    }

    async _doVerification() {
        if (!this.startEvent) {
            // TODO: Support scanning QR codes
            throw new Error("It is not currently possible to start verification" +
                "with this method yet.");
        }

        const {qrCodeData} = this.request;
        // 1. check the secret
        if (this.startEvent.getContent()['secret'] !== qrCodeData.encodedSharedSecret) {
            throw newKeyMismatchError();
        }

        // 2. ask if other user shows shield as well
        await new Promise((resolve, reject) => {
            this.reciprocateQREvent = {
                confirm: resolve,
                cancel: () => reject(newUserCancelledError()),
            };
            this.emit("show_reciprocate_qr", this.reciprocateQREvent);
        });

        // 3. determine key to sign
        const keys = {};
        if (qrCodeData.mode === MODE_VERIFY_OTHER_USER) {
            // add master key to keys to be signed, only if we're not doing self-verification
            const masterKey = qrCodeData.otherUserMasterKey;
            keys[`ed25519:${masterKey}`] = masterKey;
        } else if (qrCodeData.mode === MODE_VERIFY_SELF_TRUSTED) {
            const deviceId = this.request.targetDevice.deviceId;
            keys[`ed25519:${deviceId}`] = qrCodeData.otherDeviceKey;
        } else {
            // TODO: not sure if MODE_VERIFY_SELF_UNTRUSTED makes sense to sign anything here?
        }

        // 4. sign the key
        await this._verifyKeys(this.userId, keys, (keyId, device, keyInfo) => {
            // make sure the device has the expected keys
            const targetKey = keys[keyId];
            if (!targetKey) throw newKeyMismatchError();

            if (keyInfo !== targetKey) {
                console.error("key ID from key info does not match");
                throw newKeyMismatchError();
            }
            for (const deviceKeyId in device.keys) {
                if (!deviceKeyId.startsWith("ed25519")) continue;
                const deviceTargetKey = keys[deviceKeyId];
                if (!deviceTargetKey) throw newKeyMismatchError();
                if (device.keys[deviceKeyId] !== deviceTargetKey) {
                    console.error("master key does not match");
                    throw newKeyMismatchError();
                }
            }
        });
    }
}

const CODE_VERSION = 0x02; // the version of binary QR codes we support
const BINARY_PREFIX = "MATRIX"; // ASCII, used to prefix the binary format
const MODE_VERIFY_OTHER_USER = 0x00; // Verifying someone who isn't us
const MODE_VERIFY_SELF_TRUSTED = 0x01; // We trust the master key
const MODE_VERIFY_SELF_UNTRUSTED = 0x02; // We do not trust the master key

export class QRCodeData {
    constructor(mode, sharedSecret, otherUserMasterKey, otherDeviceKey, buffer) {
        this._sharedSecret = sharedSecret;
        this._mode = mode;
        this._otherUserMasterKey = otherUserMasterKey;
        this._otherDeviceKey = otherDeviceKey;
        this._buffer = buffer;
    }

    static async create(request, client) {
        const sharedSecret = QRCodeData._generateSharedSecret();
        const mode = QRCodeData._determineMode(request, client);
        let otherUserMasterKey = null;
        let otherDeviceKey = null;
        if (mode === MODE_VERIFY_OTHER_USER) {
            const otherUserCrossSigningInfo =
                client.getStoredCrossSigningForUser(request.otherUserId);
            otherUserMasterKey = otherUserCrossSigningInfo.getId("master");
        } else if (mode === MODE_VERIFY_SELF_TRUSTED) {
            otherDeviceKey = await QRCodeData._getOtherDeviceKey(request, client);
        }
        const qrData = QRCodeData._generateQrData(
            request, client, mode,
            sharedSecret,
            otherUserMasterKey,
            otherDeviceKey,
        );
        const buffer = QRCodeData._generateBuffer(qrData);
        return new QRCodeData(mode, sharedSecret,
            otherUserMasterKey, otherDeviceKey, buffer);
    }

    get buffer() {
        return this._buffer;
    }

    get mode() {
        return this._mode;
    }

    get otherDeviceKey() {
        return this._otherDeviceKey;
    }

    get otherUserMasterKey() {
        return this._otherUserMasterKey;
    }

    /**
     * The unpadded base64 encoded shared secret.
     */
    get encodedSharedSecret() {
        return this._sharedSecret;
    }

    static _generateSharedSecret() {
        const secretBytes = new Uint8Array(11);
        global.crypto.getRandomValues(secretBytes);
        return encodeUnpaddedBase64(secretBytes);
    }

    static async _getOtherDeviceKey(request, client) {
        const myUserId = client.getUserId();
        const otherDevice = request.targetDevice;
        const otherDeviceId = otherDevice ? otherDevice.deviceId : null;
        const device = await client.getStoredDevice(myUserId, otherDeviceId);
        if (!device) {
            throw new Error("could not find device " + otherDeviceId);
        }
        const key = device.getFingerprint();
        return key;
    }

    static _determineMode(request, client) {
        const myUserId = client.getUserId();
        const otherUserId = request.otherUserId;

        let mode = MODE_VERIFY_OTHER_USER;
        if (myUserId === otherUserId) {
            // Mode changes depending on whether or not we trust the master cross signing key
            const myTrust = client.checkUserTrust(myUserId);
            if (myTrust.isCrossSigningVerified()) {
                mode = MODE_VERIFY_SELF_TRUSTED;
            } else {
                mode = MODE_VERIFY_SELF_UNTRUSTED;
            }
        }
        return mode;
    }

    static _generateQrData(request, client, mode,
        encodedSharedSecret, otherUserMasterKey, otherDeviceKey,
    ) {
        const myUserId = client.getUserId();
        const transactionId = request.channel.transactionId;
        const qrData = {
            prefix: BINARY_PREFIX,
            version: CODE_VERSION,
            mode,
            transactionId,
            firstKeyB64: '', // worked out shortly
            secondKeyB64: '', // worked out shortly
            secretB64: encodedSharedSecret,
        };

        const myCrossSigningInfo = client.getStoredCrossSigningForUser(myUserId);
        const myMasterKey = myCrossSigningInfo.getId("master");

        if (mode === MODE_VERIFY_OTHER_USER) {
            // First key is our master cross signing key
            qrData.firstKeyB64 = myMasterKey;
            // Second key is the other user's master cross signing key
            qrData.secondKeyB64 = otherUserMasterKey;
        } else if (mode === MODE_VERIFY_SELF_TRUSTED) {
            // First key is our master cross signing key
            qrData.firstKeyB64 = myMasterKey;
            qrData.secondKeyB64 = otherDeviceKey;
        } else if (mode === MODE_VERIFY_SELF_UNTRUSTED) {
            // First key is our device's key
            qrData.firstKeyB64 = client.getDeviceEd25519Key();
            // Second key is what we think our master cross signing key is
            qrData.secondKeyB64 = myMasterKey;
        }
        return qrData;
    }

    static _generateBuffer(qrData) {
        let buf = Buffer.alloc(0); // we'll concat our way through life

        const appendByte = (b) => {
            const tmpBuf = Buffer.from([b]);
            buf = Buffer.concat([buf, tmpBuf]);
        };
        const appendInt = (i) => {
            const tmpBuf = Buffer.alloc(2);
            tmpBuf.writeInt16BE(i, 0);
            buf = Buffer.concat([buf, tmpBuf]);
        };
        const appendStr = (s, enc, withLengthPrefix = true) => {
            const tmpBuf = Buffer.from(s, enc);
            if (withLengthPrefix) appendInt(tmpBuf.byteLength);
            buf = Buffer.concat([buf, tmpBuf]);
        };
        const appendEncBase64 = (b64) => {
            const b = decodeBase64(b64);
            const tmpBuf = Buffer.from(b);
            buf = Buffer.concat([buf, tmpBuf]);
        };

        // Actually build the buffer for the QR code
        appendStr(qrData.prefix, "ascii", false);
        appendByte(qrData.version);
        appendByte(qrData.mode);
        appendStr(qrData.transactionId, "utf-8");
        appendEncBase64(qrData.firstKeyB64);
        appendEncBase64(qrData.secondKeyB64);
        appendEncBase64(qrData.secretB64);

        return buf;
    }
}
