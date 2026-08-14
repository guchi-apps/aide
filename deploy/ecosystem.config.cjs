// package.json が "type": "module" のため、.js だとESM扱いになり module.exports が効かない。
// PM2の設定はCommonJSで書く必要があるので拡張子を .cjs にしている。
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "aide",
      // Node 24 が .ts を型ストリッピングで直接実行するため、ビルド成果物は無い。
      script: "src/server.ts",
      cwd: path.resolve(__dirname, ".."),
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      // メモリ2GBのVPSに多数のプロセスが常駐している。Nodeの既定ヒープ上限では
      // GCが働かず抱え込むため、明示して早めに回収させる。
      // AIDEはキャッシュを読んで返すだけで大きな中間データを持たないため、
      // Next.jsアプリ（128MB）より小さく取れる。
      // PM2は .env を自動で読まない。認証情報を渡せないとサーバーは起動を拒否するため、
      // Node標準の機能で読み込ませる（asset-manager のジョブと同じ方式）。
      node_args: "--max-old-space-size=96 --env-file-if-exists=.env",
      max_memory_restart: "256M",
      env_production: {
        NODE_ENV: "production",
        PORT: process.env.PORT || 3114,
        HOST: "127.0.0.1",
      },
    },
  ],
};
