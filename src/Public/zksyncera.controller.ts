/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Context, Hono } from 'hono';
import { Env } from '../../environment';
import { zkSyncEraService } from './zkSyncEraService';
import { zkSyncEraConfig } from './zksyncera.config';

// checkSession is session authentication middleware provided by an internal package

type UsageContext = { Bindings: Env; };

const app = new Hono<UsageContext>().basePath('/new-zksyncera');

// Hydrates purchase window config with today's claim status and per-window ball allotment
const buildPurchaseWindows = (
  claimData: Array<{ calendar_day: string }>,
  mintableBalance: number
) =>
  zkSyncEraConfig.map(item => {
    const itemDate = item.date.slice(0, 10);
    const claimed = claimData.some(claim => claim.calendar_day.slice(0, 10) === itemDate);
    return { ...item, ballBalance: mintableBalance / 10, claimed };
  });

app.post('/connect', checkSession(), async (c: Context<UsageContext>) => {
  const isAuthenticated = c.get('IS_AUTHENTICATED');
  if (!isAuthenticated) {
    return c.json({ message: 'Unauthorized' }, { status: 401 });
  }
  const userId = c.get('USER_ID');

  const service = zkSyncEraService(c.env, userId);

  const [ballCount, claimData, initialMintableBalance] = await Promise.all([
    service.getInventory(),
    service.getClaimDataAll(),
    service.getInitialZkSyncEraAvailableToMint()
  ]);

  const mintableBalance = await service.zkSyncEraMintableBalance();

  const result = {
    current_balls: Number(ballCount.ballCount),
    purchaseWindows: buildPurchaseWindows(claimData, initialMintableBalance),
    mintableBalance: mintableBalance,
  };

  return c.json(result);
});

// get how many tokens the user can mint
app.get('/zksyncera-available', checkSession(), async (c) => {
  const isAuthenticated = c.get('IS_AUTHENTICATED');
  if (!isAuthenticated) {
    return c.json({ message: 'Unauthorized' }, { status: 401 });
  }
  const userId = c.get('USER_ID');

  const service = zkSyncEraService(c.env, userId);

  const response = await service.zkSyncEraMintableBalance();

  return c.json({ balance: response });
});

// get the user inventory - ball count, token count, etc
app.get('/get-inventory', checkSession(), async (c) => {
  const isAuthenticated = c.get('IS_AUTHENTICATED');
  if (!isAuthenticated) {
    return c.json({ message: 'Unauthorized' }, { status: 401 });
  }
  const userId = c.get('USER_ID');

  const service = zkSyncEraService(c.env, userId);

  const ballCount = await service.getInventory();

  const result = {
    data: ballCount,
  };

  return c.json(result);
});

app.post('/override/deposit', async(c) => {
  const payload = await c.req.json();

  const userId = payload.user_id;
  const amount = payload.amount;

  const zkSyncEraApiKey = c.req.header('zksyncera-api-key');

  if (zkSyncEraApiKey !== c.env.ZKSYNCERA_API_KEY) {
    return c.json({ response: "Invalid" }, 403);
  }

  const zkSyncEraServiceCaller = zkSyncEraService(c.env, userId);

  const walletAddress = await zkSyncEraServiceCaller.getWalletAddress();

  console.log({ userId, amount, walletAddress });

  const mintResponse = await zkSyncEraServiceCaller.mintZkSyncEraToken(amount, walletAddress);

  return c.json({ mintResponse, userId, amount, walletAddress });
});

app.post('/override/add-balls', async(c) => {
  const payload = await c.req.json();
  const userId = payload.user_id;
  const amount = payload.amount;
  const zkSyncEraApiKey = c.req.header('zksyncera-api-key');

  if (zkSyncEraApiKey !== c.env.ZKSYNCERA_API_KEY) {
    return c.json({ response: "Invalid" }, 403);
  }

  const zkSyncEraServiceCaller = zkSyncEraService(c.env, userId);

  try {
    const burnTxHash = await zkSyncEraServiceCaller.addBalls(amount);
    const ballCount = await zkSyncEraServiceCaller.getInventory();
    const mintableBalance = await zkSyncEraServiceCaller.zkSyncEraMintableBalance();

    const result = {
      current_balls: Number(ballCount.ballCount),
      mintableBalance: Number(mintableBalance),
      tx: burnTxHash.tx,
    };

    return c.json({ result });
  } catch (error) {
    return c.json({ error: 'add-balls.failed - ' + error }, 400)
  }
});

app.post('/game/start', checkSession(), async (c) => {
  // starts and renders the game
});

// initial "claim" to mint the tokens
app.post('/claim-zksyncera', checkSession(), async(c) => {
  const isAuthenticated = c.get('IS_AUTHENTICATED');
  if (!isAuthenticated) {
    return c.json({ message: 'Unauthorized' }, { status: 401 });
  }
  const userId = c.get('USER_ID');

  const zkSyncEraServiceCaller = zkSyncEraService(c.env, userId);

  let walletAddress = '';

  try {
    walletAddress = await zkSyncEraServiceCaller.getWalletAddress();
  } catch (error) {
    return c.json({ error: 'wallet-connection.failed' }, 412);
  }

  try {
    const mintableBalance = await zkSyncEraServiceCaller.zkSyncEraMintableBalance();

    const result = await zkSyncEraServiceCaller.mintZkSyncEraToken(mintableBalance, walletAddress);

    return c.json({ result: {tx: result} }, 200);
  } catch (error) {
    return c.json({ error: 'minting.failed' }, 402)
  }
});

// Buy balls with tokens. Burn token, add balls
app.post('/add-balls', checkSession(), async(c) => {
  const isAuthenticated = c.get('IS_AUTHENTICATED');
  if (!isAuthenticated) {
    return c.json({ message: 'Unauthorized' }, { status: 401 });
  }
  const userId = c.get('USER_ID');

  const zkSyncEraServiceCaller = zkSyncEraService(c.env, userId);

  const claimDataToday = await zkSyncEraServiceCaller.getClaimData();
  const initialMintableBalance = await zkSyncEraServiceCaller.getInitialZkSyncEraAvailableToMint();

  const totalQuantity = (claimDataToday[0]?.total_quantity ?? 0) as number;
  const dailyBurn = initialMintableBalance / 10;

  if(totalQuantity >= dailyBurn) {
    return c.json({ error: 'allotment.depleted' }, 412)
  }

  try {
    const burnTxHash = await zkSyncEraServiceCaller.addBalls(dailyBurn);

    const [ballCount, claimData] = await Promise.all([
      zkSyncEraServiceCaller.getInventory(),
      zkSyncEraServiceCaller.getClaimDataAll(),
    ]);

    const mintableBalance = await zkSyncEraServiceCaller.zkSyncEraMintableBalance();

    const result = {
      current_balls: Number(ballCount.ballCount),
      purchaseWindows: buildPurchaseWindows(claimData, initialMintableBalance),
      mintableBalance: Number(mintableBalance),
      tx: burnTxHash.tx,
    };

    return c.json({ result });
  } catch (error) {
    return c.json({ error: 'add-balls.failed' }, 400)
  }
});

// Get user's wallet address
app.get('/wallet-address', checkSession(), async(c) => {
  const isAuthenticated = c.get('IS_AUTHENTICATED');
  if (!isAuthenticated) {
    return c.json({ message: 'Unauthorized' }, { status: 401 });
  }
  const userId = c.get('USER_ID');

  const zkSyncEraServiceCaller = zkSyncEraService(c.env, userId);

  const walletAddress = await zkSyncEraServiceCaller.getWalletAddress();

  return c.json({ walletAddress });
});

export default app;
