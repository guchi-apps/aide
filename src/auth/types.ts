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
  expiresAt: number;
  createdAt: string;
}

export interface AuthState {
  clients: OAuthClient[];
  codes: AuthCode[];
  tokens: AccessToken[];
}
