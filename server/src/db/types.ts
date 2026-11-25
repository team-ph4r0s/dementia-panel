/**
 * Типы строк таблиц SQLite (соответствуют схеме и миграциям в server/src/db/index.ts).
 */

export interface AdminRow {
  id: number;
  username: string;
  password_hash: string;
  salt: string;
  totp_secret: string | null;
  totp_enabled: number;
  recovery_codes: string | null;
  created_at: string;
}

export interface SessionRow {
  id: number;
  token: string;
  admin_id: number;
  ip: string | null;
  user_agent: string | null;
  last_activity: string;
  expires_at: string;
  created_at: string;
  role: 'admin' | 'guest';
}

export interface SubscriberRow {
  id: number;
  name: string;
  token: string;
  enabled: number;
  suspended: number;
  traffic_limit: number;
  expire_at: string | null;
  country: string | null;
  created_at: string;
}

export interface ServerRow {
  id: number;
  name: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_password: string | null;
  ssh_key: string | null;
  host_key: string | null;
  awg_port: number;
  deployed_port: number | null;
  subnet: string;
  server_public_key: string | null;
  server_private_key: string | null;
  preshared_key: string | null;
  awg_version: number;
  jc: number;
  jmin: number;
  jmax: number;
  s1: number;
  s2: number;
  s3: number | null;
  s4: number | null;
  h1: string | number;
  h2: string | number;
  h3: string | number;
  h4: string | number;
  i1: string | null;
  i2: string | null;
  i3: string | null;
  i4: string | null;
  i5: string | null;
  header_protection_key: string | null;
  extra_params: string | null;
  container_name: string;
  iface: string;
  conf_path: string;
  awg_tool: string;
  managed_by: string;
  sub_name: string | null;
  sub_order: number;
  status: string;
  needs_sync: number;
  needs_apply: number;
  fail_count: number;
  last_error: string | null;
  last_seen: string | null;
  remote_panel_id: number | null;
  remote_node_id: number | null;
  node_awg_go: string | null;
  node_awg_tools: string | null;
  node_image: string | null;
  node_image_created: string | null;
  node_info_at: string | null;
  probe_port: number | null;
  stub_port: number | null;
  stub_token: string | null;
  country: string | null;
  protocol: string;
  reality_sni: string | null;
  reality_dest: string | null;
  reality_short_ids: string | null;
  xray_flow: string | null;
  xray_fingerprint: string | null;
  xray_transport: string | null;
  xhttp_path: string | null;
  xhttp_mode: string | null;
  cdn_enabled: number;
  cdn_domain: string | null;
  cdn_port: number | null;
  cdn_address: string | null;
  cdn_zone: string | null;
  cdn_record: string | null;
  cdn_origin_ip: string | null;
  cdn_cert: string | null;
  cdn_key: string | null;
  cdn_expires_at: string | null;
  cdn_error: string | null;
  extra_ports: string | null;
  extra_ports_hash: string | null;
  extra_ports_error: string | null;
  created_at: string;
}

export interface ClientRow {
  id: number;
  server_id: number;
  subscriber_id: number | null;
  partner_id: number | null;
  name: string;
  client_ip: string;
  client_public_key: string;
  client_private_key: string;
  preshared_key: string | null;
  client_uuid: string | null;
  enabled: number;
  external: number;
  owner_blocked: number;
  remote_ref: string | null;
  remote_peer_id: number | null;
  remote_state: string | null;
  total_rx: number;
  total_tx: number;
  rx_counter: number;
  tx_counter: number;
  last_handshake: string | null;
  created_at: string;
}

export interface PartnerRow {
  id: number;
  name: string;
  token_hash: string;
  token_hint: string;
  enabled: number;
  suspended: number;
  max_clients: number;
  traffic_limit: number;
  expire_at: string | null;
  last_used_at: string | null;
  last_ip: string | null;
  created_at: string;
}

export interface RemotePanelRow {
  id: number;
  name: string;
  base_url: string;
  token: string;
  partner_name: string | null;
  status: string;
  limits: string | null;
  last_sync_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface BridgeRow {
  id: number;
  name: string;
  host: string;
  ssh_port: number;
  ssh_user: string;
  ssh_password: string | null;
  ssh_key: string | null;
  host_key: string | null;
  country: string;
  status: string;
  rules_hash: string | null;
  needs_apply: number;
  fail_count: number;
  last_error: string | null;
  last_seen: string | null;
  panel_forward: number;
  created_at: string;
}

export interface BridgeLinkRow {
  bridge_id: number;
  server_id: number;
  listen_port: number;
  mode: 'auto' | 'main' | 'always' | 'off';
  check_ok: number | null;
  checked_at: string | null;
  cascade_port: number | null;
  cascade_secret: string | null;
  cascade_pending: number;
}

export interface BridgeStateRow {
  server_id: number;
  country: string;
  active: number;
  fail_streak: number;
  ok_streak: number;
  reason: string | null;
  changed_at: string | null;
}

export interface ProbeResultRow {
  server_id: number;
  country: string;
  ok_nodes: number;
  total_nodes: number;
  rtt_ms: number | null;
  checked_at: string;
  method: string;
  tcp_ok: number | null;
  udp_ok: number | null;
  spoofed: number;
  verified: number;
  gp_ok: number | null;
  gp_total: number | null;
  gp_eyeball: number | null;
}

export interface EventRow {
  id: number;
  level: string;
  type: string;
  message: string;
  entity_kind: string | null;
  entity_id: string | null;
  created_at: string;
}

export interface NodeUpdateRow {
  server_id: number;
  current_image: string | null;
  latest_image: string | null;
  available: number;
  checked_at: string | null;
  attempted_at: string | null;
  updated_at: string | null;
  result: string | null;
  error: string | null;
}

export interface ProviderAccountRow {
  target_type: 'panel' | 'node' | 'bridge';
  target_id: number;
  url: string | null;
  login: string | null;
  password: string | null;
  amount: number | null;
  currency: string;
  pay_day: number | null;
  pay_month: number | null;
  updated_at: string;
}
