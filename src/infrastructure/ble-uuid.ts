/** Normalise a BLE UUID: lowercase, no dashes, 16-bit form for Bluetooth SIG base UUIDs ("2ad2"). */
export const norm = (uuid: string) => uuid.replace(/-/g, '').toLowerCase().replace(/^0000(....)00001000800000805f9b34fb$/, '$1');
