/** 動的クライアント登録（RFC 7591）で登録されたクライアント。 */
export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
}

/**
 * 認可したときにログインしていた本人（`mail:read` を求める認可だけが記録する。#905）。
 * 値はSupabaseが検証した `sub` とメールアドレスで、クライアントの自己申告ではない。
 */
export interface AuthorizedSubject {
  sub: string;
  email: string;
}

/** 認可コード。ワンタイムかつ短命。 */
export interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  /** PKCE の code_challenge（S256のみ受け付ける）。 */
  codeChallenge: string;
  resource: string | null;
  /** クライアントが明示的に要求し、利用者が認可したMCPの権限。 */
  scopes?: string[];
  /** 認可時にログインしていた本人。`mail:read` を付与したときだけ入る。 */
  subject?: AuthorizedSubject;
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
  /** リフレッシュ後も変えない認可済みの権限。古いトークンは空配列として扱う。 */
  scopes?: string[];
  /** 認可時の本人。リフレッシュ後も引き継ぐ。`mail:read` を持つ古いトークンには無い。 */
  subject?: AuthorizedSubject;
  createdAt: string;
}

export interface AuthState {
  clients: OAuthClient[];
  codes: AuthCode[];
  tokens: AccessToken[];
}
