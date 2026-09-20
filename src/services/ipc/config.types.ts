/** config IPC DTOs. Kept separate for generated Rust binding integration. */

export interface OrphanSecretDto {
  id: string;
  namespace: string;
  secretType: 'apiKey' | 'chatgptSession';
  secretRef: string;
}
