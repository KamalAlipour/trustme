import { ContractFactory, JsonRpcProvider, Wallet, ZeroAddress, getAddress } from 'ethers';
import { trustCouponEscrowAbi, trustCouponEscrowBytecode } from '../packages/core/src/escrow-abi.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
};

const rpcUrl = required('POLYGON_RPC_URL');
const deployerKey = required('ESCROW_DEPLOYER_KEY');
const token = getAddress(required('USDT_CONTRACT_ADDRESS'));
const vault = getAddress(required('ESCROW_VAULT_ADDRESS'));
const settler = getAddress(required('ESCROW_SETTLER_ADDRESS'));
if (settler === ZeroAddress) throw new Error('ESCROW_SETTLER_ADDRESS must not be the zero address');
const provider = new JsonRpcProvider(rpcUrl);
const deployer = new Wallet(deployerKey, provider);
const factory = new ContractFactory(trustCouponEscrowAbi, trustCouponEscrowBytecode, deployer);
const contract = await factory.deploy(token, vault);
await contract.waitForDeployment();
const address = await contract.getAddress();
const settlerTransaction = await contract.getFunction('setSettler')(settler);
await settlerTransaction.wait();
const configuredSettler = getAddress(await contract.getFunction('settler')());
if (configuredSettler !== settler) {
  throw new Error(`TrustCouponEscrow settler mismatch: expected ${settler}, got ${configuredSettler}`);
}
process.stdout.write(`TrustCouponEscrow deployed at ${address} on chain ${(await provider.getNetwork()).chainId.toString()} (token ${token}, vault ${vault}, settler ${settler})\n`);
