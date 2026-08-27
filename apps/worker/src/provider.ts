import {
  JsonRpcProvider,
  Contract,
  Wallet,
  type FeeData,
  type Log,
  type TransactionReceipt,
  type TransactionRequest,
} from 'ethers';

export type ChainLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: string;
  index: number;
};

export type ChainReceipt = {
  status: number | null;
  blockNumber: number;
  transactionHash: string;
};

export type LogFilter = {
  address: string;
  topics: string[][];
  fromBlock: number;
  toBlock: number;
};

export type FeeEstimate = {
  gasPrice?: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
};

export interface ChainProvider {
  getBlockNumber(): Promise<number>;
  getBlockHash(blockNumber: number): Promise<string | null>;
  getLogs(filter: LogFilter): Promise<ChainLog[]>;
  getTransactionReceipt(hash: string): Promise<ChainReceipt | null>;
  sendTransaction(signedTransaction: string): Promise<void>;
  estimateFees(): Promise<FeeEstimate>;
  estimateGas(transaction: TransactionRequest): Promise<bigint>;
  getChainId(): Promise<bigint>;
  getNativeBalance(address: string): Promise<bigint>;
  getTokenBalance(tokenAddress: string, ownerAddress: string): Promise<bigint>;
  getTransactionCount(address: string, blockTag: 'latest' | 'pending'): Promise<number>;
}

export interface TransactionSigner {
  readonly address: string;
  signTransaction(transaction: TransactionRequest): Promise<string>;
}

function toChainLog(log: Log): ChainLog {
  return {
    address: log.address,
    topics: [...log.topics],
    data: log.data,
    blockNumber: log.blockNumber,
    transactionHash: log.transactionHash,
    index: log.index,
  };
}

function toChainReceipt(receipt: TransactionReceipt): ChainReceipt {
  return {
    status: receipt.status,
    blockNumber: receipt.blockNumber,
    transactionHash: receipt.hash,
  };
}

export class EthersChainProvider implements ChainProvider {
  public constructor(private readonly provider: JsonRpcProvider) {}

  public async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  public async getBlockHash(blockNumber: number): Promise<string | null> {
    const block = await this.provider.getBlock(blockNumber);
    return block?.hash ?? null;
  }

  public async getLogs(filter: LogFilter): Promise<ChainLog[]> {
    return (await this.provider.getLogs(filter)).map(toChainLog);
  }

  public async getTransactionReceipt(hash: string): Promise<ChainReceipt | null> {
    const receipt = await this.provider.getTransactionReceipt(hash);
    return receipt ? toChainReceipt(receipt) : null;
  }

  public async sendTransaction(signedTransaction: string): Promise<void> {
    await this.provider.broadcastTransaction(signedTransaction);
  }

  public async estimateFees(): Promise<FeeEstimate> {
    const feeData: FeeData = await this.provider.getFeeData();
    return {
      ...(feeData.gasPrice === null ? {} : { gasPrice: feeData.gasPrice }),
      ...(feeData.maxFeePerGas === null ? {} : { maxFeePerGas: feeData.maxFeePerGas }),
      ...(feeData.maxPriorityFeePerGas === null ? {} : { maxPriorityFeePerGas: feeData.maxPriorityFeePerGas }),
    };
  }

  public async estimateGas(transaction: TransactionRequest): Promise<bigint> {
    return this.provider.estimateGas(transaction);
  }

  public async getChainId(): Promise<bigint> {
    return (await this.provider.getNetwork()).chainId;
  }

  public async getNativeBalance(address: string): Promise<bigint> {
    return this.provider.getBalance(address);
  }

  public async getTokenBalance(tokenAddress: string, ownerAddress: string): Promise<bigint> {
    const token = new Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], this.provider);
    const balanceOf = token.getFunction('balanceOf');
    return BigInt(await balanceOf(ownerAddress));
  }

  public async getTransactionCount(address: string, blockTag: 'latest' | 'pending'): Promise<number> {
    return this.provider.getTransactionCount(address, blockTag);
  }
}

export function createEthersProvider(urlOrProvider: string | JsonRpcProvider): EthersChainProvider {
  return new EthersChainProvider(typeof urlOrProvider === 'string' ? new JsonRpcProvider(urlOrProvider) : urlOrProvider);
}

export function createWalletSigner(privateKey: string, provider: JsonRpcProvider): TransactionSigner {
  return new Wallet(privateKey, provider);
}

export type FakeProviderOptions = {
  head?: number;
  blockHashes?: Map<number, string>;
  logs?: ChainLog[];
  receipts?: Map<string, ChainReceipt | null>;
  fees?: FeeEstimate;
  chainId?: bigint;
  gasEstimate?: bigint;
  nativeBalances?: Map<string, bigint>;
  tokenBalances?: Map<string, bigint>;
  pendingNonce?: number;
  latestNonce?: number;
  nonce?: number;
  onSendTransaction?: (signedTransaction: string) => Promise<void>;
};

export class FakeChainProvider implements ChainProvider {
  public readonly sentTransactions: string[] = [];
  private readonly options: FakeProviderOptions;

  public constructor(options: FakeProviderOptions = {}) {
    this.options = options;
  }

  public async getBlockNumber(): Promise<number> {
    return this.options.head ?? 0;
  }

  public async getBlockHash(blockNumber: number): Promise<string | null> {
    return this.options.blockHashes?.get(blockNumber) ?? null;
  }

  public async getLogs(filter: LogFilter): Promise<ChainLog[]> {
    return (this.options.logs ?? []).filter(
      (log) =>
        log.address.toLowerCase() === filter.address.toLowerCase() &&
        log.blockNumber >= filter.fromBlock &&
        log.blockNumber <= filter.toBlock,
    );
  }

  public async getTransactionReceipt(hash: string): Promise<ChainReceipt | null> {
    return this.options.receipts?.get(hash) ?? null;
  }

  public async sendTransaction(signedTransaction: string): Promise<void> {
    this.sentTransactions.push(signedTransaction);
    await this.options.onSendTransaction?.(signedTransaction);
  }

  public async estimateFees(): Promise<FeeEstimate> {
    return this.options.fees ?? { gasPrice: 1n };
  }

  public async estimateGas(): Promise<bigint> {
    return this.options.gasEstimate ?? 50_000n;
  }

  public async getChainId(): Promise<bigint> {
    return this.options.chainId ?? 137n;
  }

  public async getNativeBalance(address: string): Promise<bigint> {
    return this.options.nativeBalances?.get(address.toLowerCase()) ?? 10n ** 18n;
  }

  public async getTokenBalance(tokenAddress: string, ownerAddress: string): Promise<bigint> {
    return this.options.tokenBalances?.get(`${tokenAddress.toLowerCase()}:${ownerAddress.toLowerCase()}`) ?? 10n ** 30n;
  }

  public async getTransactionCount(_address: string, blockTag: 'latest' | 'pending'): Promise<number> {
    return blockTag === 'pending'
      ? (this.options.pendingNonce ?? this.options.nonce ?? 0)
      : (this.options.latestNonce ?? this.options.nonce ?? 0);
  }
}

export class FakeTransactionSigner implements TransactionSigner {
  public readonly address: string;
  public signCount = 0;

  public readonly signedRequests: TransactionRequest[] = [];

  public constructor(
    address: string,
    private readonly signedTransaction = '0x01',
    private readonly onSign?: (transaction: TransactionRequest) => Promise<void>,
  ) {
    this.address = address;
  }

  public async signTransaction(transaction: TransactionRequest): Promise<string> {
    this.signCount += 1;
    this.signedRequests.push(transaction);
    await this.onSign?.(transaction);
    return this.signedTransaction;
  }
}
