import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { GET } from "@/app/.well-known/farcaster.json/route";

const ENV_KEYS = [
  "NEXT_PUBLIC_MINI_APP_URL",
  "NEXT_PUBLIC_MINI_APP_REQUIRED_CAPABILITIES",
  "NEXT_PUBLIC_MINI_APP_REQUIRED_CHAINS"
] as const;

const envSnapshot = new Map<string, string | undefined>();
for (const key of ENV_KEYS) {
  envSnapshot.set(key, process.env[key]);
}

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_MINI_APP_REQUIRED_CAPABILITIES;
  delete process.env.NEXT_PUBLIC_MINI_APP_REQUIRED_CHAINS;
  process.env.NEXT_PUBLIC_MINI_APP_URL = "https://mini.swipen.xyz";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const previous = envSnapshot.get(key);
    if (previous === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = previous;
  }
});

test("manifest includes Base chain and ethereum provider capability by default", async () => {
  const response = await GET(new Request("https://mini.swipen.xyz/.well-known/farcaster.json"));
  const body = (await response.json()) as {
    miniapp: {
      requiredCapabilities?: string[];
      requiredChains?: string[];
    };
    frame: {
      requiredCapabilities?: string[];
      requiredChains?: string[];
    };
  };

  assert.equal(response.status, 200);
  assert.deepEqual(body.miniapp.requiredCapabilities, ["wallet.getEthereumProvider"]);
  assert.deepEqual(body.miniapp.requiredChains, ["eip155:8453"]);
  assert.deepEqual(body.frame.requiredCapabilities, ["wallet.getEthereumProvider"]);
  assert.deepEqual(body.frame.requiredChains, ["eip155:8453"]);
});

test("manifest allows required capabilities and chains to be overridden", async () => {
  process.env.NEXT_PUBLIC_MINI_APP_REQUIRED_CAPABILITIES = "wallet.getEthereumProvider,actions.signIn";
  process.env.NEXT_PUBLIC_MINI_APP_REQUIRED_CHAINS = "eip155:8453,eip155:10";

  const response = await GET(new Request("https://mini.swipen.xyz/.well-known/farcaster.json"));
  const body = (await response.json()) as {
    miniapp: {
      requiredCapabilities?: string[];
      requiredChains?: string[];
    };
  };

  assert.equal(response.status, 200);
  assert.deepEqual(body.miniapp.requiredCapabilities, ["wallet.getEthereumProvider", "actions.signIn"]);
  assert.deepEqual(body.miniapp.requiredChains, ["eip155:8453", "eip155:10"]);
});
