import { Context, Hono } from 'hono';
import { ExportedHandler } from 'cloudflare:workers';
import { createWalletClient, http, parseAbi, parseUnits } from 'viem';
import { zkSync } from 'viem/chains';
import { eip712WalletActions } from 'viem/zksync';
import { zkSyncEraConfig } from './zksync-era.config';

interface Env {
	ZKSYNC_ERA_TOKEN_SALT: string;
}

const app = new Hono<{ Bindings: Env }>();

app.post('/token/burn', async (c: Context<{ Bindings: Env }>) => {
	const { service, input, amount } = await c.req.json();

	// Key derivation and wallet account creation are handled by a separate internal service
	const privateKey = await derivePrivateKeyForService(service, input, c.env);
	const account = privateKeyToAccount(privateKey);

	const RPC_URL = zkSyncEraConfig.RPC_URL;
	const TOKEN_ADDRESS = zkSyncEraConfig.TOKEN_ADDRESS;
	const PAYMASTER_ADDRESS = zkSyncEraConfig.PAYMASTER_ADDRESS;
	const PAYMASTER_INPUT = zkSyncEraConfig.PAYMASTER_INPUT;

	const client = createWalletClient({
		account,
		chain: zkSync,
		transport: http(RPC_URL),
	}).extend(eip712WalletActions());

	const abi = parseAbi([
		'function burn(uint256 value, string uuid) nonpayable',
	]);

	const burnAmount = parseUnits(String(amount), 18);

	const hash = await client.writeContract({
		account: account,
		address: TOKEN_ADDRESS,
		abi,
		functionName: 'burn',
		args: [burnAmount, input],
		paymaster: PAYMASTER_ADDRESS,
		paymasterInput: PAYMASTER_INPUT,
		gasPerPubdata: 50000n,
	});

	return c.json({ 'tx' : hash });
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
