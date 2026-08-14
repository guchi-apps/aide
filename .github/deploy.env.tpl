# Vault: apps — aide / Server / githubaction-sshkey
SSH_PRIVATE_KEY=op://apps/githubaction-sshkey/private_key?ssh-format=openssh
HOST=op://apps/Server/host
USERNAME=op://apps/Server/username
SSH_PORT=op://apps/Server/ssh-port
TARGET_DIR=op://apps/aide/target-dir
PORT=op://apps/aide/port

# MCPエンドポイントの認証。未設定だとサーバーは起動しない。
AIDE_AUTH_PASSWORD=op://apps/aide/auth-password
# OAuthメタデータに載せる公開URL。リバースプロキシ配下ではHostから推測できない。
AIDE_BASE_URL=op://apps/aide/base-url
# サブPCのworkerから取得結果を受け取るための共有シークレット。
AIDE_INGEST_SECRET=op://apps/aide/ingest-secret

SIGNALY_WEBHOOK_URL=op://apps/aide/ci-webhook-url
