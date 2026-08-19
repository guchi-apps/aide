import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  authorizationHeader,
  loadZaimOAuthCredentials,
  normalizeParams,
  percentEncode,
  sign,
  signatureBaseString,
  signingKey,
  type ZaimOAuthCredentials,
} from "./oauth.ts";

/**
 * 署名がずれてもZaimは 401 を返すだけで、どこが違うのかは教えてくれない。
 * **仕様（RFC 5849）側に固定された答えがある部分**をここで押さえておく。
 *
 * 素材は RFC 5849 §3.4.1 の例。同じキーを2回渡す例だけは、このコネクタが
 * `Record<string, string>` でパラメータを持つため落としてある。
 */

const CREDENTIALS: ZaimOAuthCredentials = {
  consumerKey: "9djdj82h48djs9d2",
  consumerSecret: "j49sk3j29djd",
  accessToken: "kkk9d7dh3k39sjv7",
  accessTokenSecret: "dh893hdasih9",
};

const RFC_PARAMS = {
  b5: "=%3D",
  a3: "a",
  "c@": "",
  a2: "r b",
  c2: "",
  oauth_consumer_key: CREDENTIALS.consumerKey,
  oauth_nonce: "7d8f3e4a",
  oauth_signature_method: "HMAC-SHA1",
  oauth_timestamp: "137131201",
  oauth_token: CREDENTIALS.accessToken,
};

describe("percentEncode", () => {
  it("encodeURIComponent が素通しする5文字もエンコードする", () => {
    // ここを取りこぼすと、店名に ( ) や ! が入った登録だけが 401 になる。
    assert.equal(percentEncode("!'()*"), "%21%27%28%29%2A");
  });

  it("非予約文字（英数字と -._~）はそのまま残す", () => {
    assert.equal(percentEncode("aZ09-._~"), "aZ09-._~");
  });

  it("空白は + ではなく %20 になる", () => {
    assert.equal(percentEncode("r b"), "r%20b");
  });
});

describe("normalizeParams", () => {
  it("エンコード後のキー順に並べる（RFC 5849 の例と同じ並び）", () => {
    assert.equal(
      normalizeParams(RFC_PARAMS),
      "a2=r%20b&a3=a&b5=%3D%253D&c%40=&c2=&oauth_consumer_key=9djdj82h48djs9d2" +
        "&oauth_nonce=7d8f3e4a&oauth_signature_method=HMAC-SHA1&oauth_timestamp=137131201" +
        "&oauth_token=kkk9d7dh3k39sjv7",
    );
  });

  it("同じキーは値の順で並ぶ", () => {
    assert.equal(normalizeParams({ a: "2", b: "1" }), "a=2&b=1");
  });
});

describe("signatureBaseString / sign", () => {
  it("RFC 5849 の例と同じ署名対象文字列を作る", () => {
    assert.equal(
      signatureBaseString("post", "http://example.com/request", RFC_PARAMS),
      "POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3Da%26b5%3D%253D%25253D" +
        "%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2%26oauth_nonce%3D7d8f3e4a" +
        "%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D137131201" +
        "%26oauth_token%3Dkkk9d7dh3k39sjv7",
    );
  });

  it("署名鍵は consumer secret と token secret を & でつなぐ", () => {
    assert.equal(signingKey("a b", "c"), "a%20b&c");
  });

  it("同じ入力からは常に同じ署名が出る", () => {
    const base = signatureBaseString("POST", "http://example.com/request", RFC_PARAMS);
    assert.equal(sign(base, CREDENTIALS.consumerSecret, CREDENTIALS.accessTokenSecret), "AYgdIfljDYmBX3Ce9owrBekam04=");
  });
});

describe("authorizationHeader", () => {
  const header = authorizationHeader(
    CREDENTIALS,
    "POST",
    "https://api.zaim.net/v2/home/money/payment",
    { amount: "1200", mapping: "1" },
    { nonce: "fixed-nonce", timestamp: 1_700_000_000 },
  );

  it("oauth_* だけを載せ、リクエストのパラメータは載せない", () => {
    // 両方載せるとZaim側で二重に数えられ、署名が合わなくなる。
    assert.match(header, /^OAuth /);
    assert.match(header, /oauth_consumer_key="9djdj82h48djs9d2"/);
    assert.match(header, /oauth_signature="[^"]+"/);
    assert.doesNotMatch(header, /amount=/);
    assert.doesNotMatch(header, /mapping=/);
  });

  it("consumer secret と access token secret は載らない", () => {
    assert.ok(!header.includes(CREDENTIALS.consumerSecret));
    assert.ok(!header.includes(CREDENTIALS.accessTokenSecret));
  });

  it("パラメータが1つ違えば署名も変わる", () => {
    const other = authorizationHeader(
      CREDENTIALS,
      "POST",
      "https://api.zaim.net/v2/home/money/payment",
      { amount: "1300", mapping: "1" },
      { nonce: "fixed-nonce", timestamp: 1_700_000_000 },
    );
    assert.notEqual(header, other);
  });
});

describe("loadZaimOAuthCredentials", () => {
  const NAMES = [
    "AIDE_ZAIM_CONSUMER_KEY",
    "AIDE_ZAIM_CONSUMER_SECRET",
    "AIDE_ZAIM_ACCESS_TOKEN",
    "AIDE_ZAIM_ACCESS_TOKEN_SECRET",
  ] as const;

  function setAll(value: string | undefined): void {
    for (const name of NAMES) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  it("4つそろって初めて有効になる", () => {
    setAll("dummy");
    assert.notEqual(loadZaimOAuthCredentials(), null);

    // 1つでも欠ければ「未設定」。半端な状態で叩くと 401 になるだけで原因が分からない。
    for (const name of NAMES) {
      const kept = process.env[name];
      delete process.env[name];
      assert.equal(loadZaimOAuthCredentials(), null, `${name} が無いのに有効になっている`);
      process.env[name] = kept;
    }
    setAll(undefined);
  });
});
