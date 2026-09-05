import { getAddress, id } from 'ethers';

export const transferTopic = id('Transfer(address,address,uint256)');

export type TransferLog = { topics: string[]; data: string };

export function decodeTransfer(log: TransferLog): { to: string; amount: bigint } | null {
  if (log.topics[0] !== transferTopic || !log.topics[2] || !/^0x[0-9a-fA-F]{64}$/.test(log.topics[2])) return null;
  try {
    return { to: getAddress(`0x${log.topics[2].slice(-40)}`), amount: BigInt(log.data) };
  } catch {
    return null;
  }
}
