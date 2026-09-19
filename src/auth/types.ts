/** 動的クライアント登録（RFC 7591）で登録されたクライアント。 */
export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
}

/** 認可コード。ワンタイムかつ短命。 */
export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  /** PKCE の code_challenge（S256のみ受け付ける）。 */
  codeChallenge: string;
  resource: string | null;
  expiresAt: number;
}

export interface AccessToken {
  token: string;
  clientId: string;
  /** リフレッシュトークン。アクセストークン失効後の再取得に使う。 */
  refreshToken: string;
  /** アクセストークンの失効時刻（ms）。 */
  expiresAt: number;
  /**
   * リフレッシュトークンの失効時刻（ms）。アクセストークンより長い。
   * この項目が無い古いレコードは `expiresAt` と同じ扱い（`refreshExpiryOf`）。
   */
  refreshExpiresAt?: number;
  createdAt: string;
}

export interface AuthState {
  clients: OAuthClient[];
  codes: AuthCode[];
  tokens: AccessToken[];
}
