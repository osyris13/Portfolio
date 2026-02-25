import { Env } from '../../environment';
import dbClient from '../../db/anonymousDataClient';
import { userCampaignInventory } from '../../db/anonymous-data';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';

import { privateKeyToAccount } from 'viem/accounts';
import { createWalletClient, http, parseAbi, parseUnits } from 'viem';
import { zkSync } from 'viem/chains';
import { eip712WalletActions } from 'viem/zksync';

export const zkSyncEraService = (env: Env, userId: string) => {
  const getActiveZkSyncEraTrackerInstance = async (
    env: Env,
    userId: string,
    activity: string,
  ) => {
    const stubId = env.ZKSYNCERA_TRACKER.idFromName(
      `${userId}_${activity}`
    );
    const stub = env.ZKSYNCERA_TRACKER.get(stubId);
    await stub.setUserId(userId);
    return stub;
  };

  const getInitialZkSyncEraAvailableToMint = (env: Env, userId: string) =>
    async () => {
      const inventory = await getInventory(env, userId)();
      return inventory.mintableCount;
    }

  const zkSyncEraMintableBalance = (env: Env, userId: string) =>
    async () => {
      const mintableBalance = await getInitialZkSyncEraAvailableToMint(env, userId)();

      const inventoryFunction = getInventory(env, userId);
      const inventory = await inventoryFunction();

      return mintableBalance - Number(inventory.mintedCount);
    }

  const addBalls = (env: Env, userId: string) =>
    async (numberOfBalls: number) => {
      const burnMethod = burnZkSyncEraToken(env, userId);
      const burnTxHash = await burnMethod(numberOfBalls);

      if (!burnTxHash) {
        throw new Error('Failed to burn tokens. Unable to proceed with purchase.');
      }
      const trackerInstance = await getActiveZkSyncEraTrackerInstance(
        env,
        userId,
        "zksyncera-game-tracker"
      );
      await trackerInstance.putInventoryItem('game-ball', numberOfBalls, 'ZKSYNC ERA game ball purchase', burnTxHash.tx);

      return burnTxHash;
    };

  const getInventory = (env: Env, userId: string) =>
    async () => {
      const [db, connection] = await dbClient(env);
      const results = await db
        .select({
          item: userCampaignInventory.item,
          totalUnits: sql`sum(${userCampaignInventory.quantity})`
        })
        .from(userCampaignInventory)
        .where(
          and(
            eq(userCampaignInventory.userUuid, userId),
            eq(userCampaignInventory.campaignId, "zksyncera"),
            inArray(userCampaignInventory.item, ['game-ball', 'game-point', 'game-mint', 'zksyncera']),
          )
        )
        .groupBy(userCampaignInventory.item);

      await connection.end();

      return {
        ballCount: Number(results.find(({ item }) => item === 'game-ball')?.totalUnits) || 0,
        pointCount: Number(results.find(({ item }) => item === 'game-point')?.totalUnits) || 0,
        mintedCount: Number(results.find(({ item }) => item === 'game-mint')?.totalUnits) || 0,
        mintableCount: Number(results.find(({ item }) => item === 'zksyncera')?.totalUnits) || 0,
      };
    };

  const getClaimData = (env: Env, userId: string) =>
    async () => {
      const [db, connection] = await dbClient(env);

      const calendarDay = sql`date_trunc('day', "created_at"::timestamp)`;

      const results = await db
        .select({
          calendar_day: calendarDay,
          total_quantity: sql`SUM(quantity)`
        })
        .from(userCampaignInventory)
        .where(
          and(
            eq(userCampaignInventory.userUuid, userId),
            eq(userCampaignInventory.item, 'game-ball'),
            gt(userCampaignInventory.quantity, 0),
            eq(calendarDay, sql`CURRENT_DATE`)
          )
        )
        .groupBy(calendarDay)
        .orderBy(calendarDay);

      await connection.end();

      return results;
    };

  const getClaimDataAll = (env: Env, userId: string) =>
    async () => {
      const [db, connection] = await dbClient(env);

      const calendarDay = sql`date_trunc('day', "created_at"::timestamp)`;

      const results = await db
        .select({
          calendar_day: calendarDay,
          total_quantity: sql`SUM(quantity)`
        })
        .from(userCampaignInventory)
        .where(
          and(
            eq(userCampaignInventory.userUuid, userId),
            eq(userCampaignInventory.item, 'game-ball'),
            gt(userCampaignInventory.quantity, 0)
          )
        )
        .groupBy(calendarDay)
        .orderBy(calendarDay);

      await connection.end();

      return results;
    };

  const mintZkSyncEraToken = (env: Env, userId: string) => async (tokensToMint: number, walletAddress: string) => {
    const PRIVATE_KEY = env.ZKSYNCERA_WALLET_PRIVATE_KEY;
    const RPC_URL = env.ZKSYNCERA_RPC_URL;
    const TOKEN_ADDRESS = env.ZKSYNCERA_TOKEN_ADDRESS;
    const PAYMASTER_ADDRESS = env.ZKSYNCERA_PAYMASTER_ADDRESS;
    const CHAIN_ID = env.ZKSYNCERA_CHAIN_ID;
    const CHAIN_NAME = env.ZKSYNCERA_CHAIN_NAME;

    // Paymaster approval calldata — approves contract interaction for gasless tx
    const PAYMASTER_INPUT = env.ZKSYNCERA_PAYMASTER_INPUT;

    const account = privateKeyToAccount(`0x${PRIVATE_KEY}`);

    const zkSyncEraChain = {
      ...zkSync,
      id: CHAIN_ID,
      name: CHAIN_NAME,
    };

    const client = createWalletClient({
      account,
      chain: zkSyncEraChain,
      transport: http(RPC_URL),
    }).extend(eip712WalletActions());

    const abi = parseAbi([
      'function mint(address to, uint256 amount) nonpayable',
    ]);

    const mintAmount = parseUnits(String(tokensToMint), 18);

    const hash = await client.writeContract({
      account: account,
      address: TOKEN_ADDRESS,
      abi,
      functionName: 'mint',
      args: [walletAddress, mintAmount],
      paymaster: PAYMASTER_ADDRESS,
      paymasterInput: PAYMASTER_INPUT,
      gasPerPubdata: 50000n,
    });

    const trackerInstance = await getActiveZkSyncEraTrackerInstance(
      env,
      userId,
      "zksyncera-game-tracker"
    );
    await trackerInstance.putInventoryItem('game-mint', tokensToMint, 'ZKSYNC ERA mint record', hash);

    return hash;
  };

  const getWalletAddress = (env: Env, userId: string) => async () => {
    const response = await env.PLATFORM_WALLET.fetch(
      'https://domain.com/',
      {
        method: 'POST',
        body: JSON.stringify({
          service: "ZKSYNCERA",
          input: userId,
        }),
      }
    );

    const { walletAddress } = await response.json() as { walletAddress: string };

    return walletAddress;
  };

  const burnZkSyncEraToken = (env: Env, userId: string) => async (burnAmount: number) => {
    const response = await env.SECURE_SERVICE.fetch(
      'https://domain.com/zksyncera/burn',
      {
        method: 'POST',
        body: JSON.stringify({
          service: "ZKSYNCERA",
          input: userId,
          amount: burnAmount,
        }),
      }
    );

    const { tx } = await response.json() as { tx: string };

    return { tx };
  };

  return {
    addBalls: addBalls(env, userId),
    getClaimData: getClaimData(env, userId),
    getClaimDataAll: getClaimDataAll(env, userId),
    getInitialZkSyncEraAvailableToMint: getInitialZkSyncEraAvailableToMint(env, userId),
    getInventory: getInventory(env, userId),
    mintZkSyncEraToken: mintZkSyncEraToken(env, userId),
    getWalletAddress: getWalletAddress(env, userId),
    zkSyncEraMintableBalance: zkSyncEraMintableBalance(env, userId),
  };
};
