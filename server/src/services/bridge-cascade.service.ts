import crypto from 'node:crypto';
import net from 'node:net';
import { HttpError } from '../utils/http.js';
import { isValidHost, shellQuote } from '../utils/net.js';
import { DEFAULT_REALITY_TARGETS } from '../utils/vless-params.js';
import { SshService, type SshCredentials } from './ssh.service.js';

export type CascadeSecret = {
  uuid: string;
  privateKey: string;
  publicKey: string;
  shortId: string;
  path: string;
  sni?: string;
};

export function parseCascadeSni(value: unknown): string | undefined {
  if (value === undefined) return;
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isValidHost(name) || !name.includes('.') || net.isIP(name) || /^[0-9.]+$/.test(name)) {
    throw new HttpError(400, 'Сайт маскировки должен быть доменным именем без порта, например dl.google.com');
  }
  return name;
}

export function generateCascadeSecret(sni: string = DEFAULT_REALITY_TARGETS[crypto.randomInt(DEFAULT_REALITY_TARGETS.length)]): CascadeSecret {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('x25519');
  return {
    uuid: crypto.randomUUID(),
    privateKey: privateKey.export({ format: 'jwk' }).d!,
    publicKey: publicKey.export({ format: 'jwk' }).x!,
    shortId: crypto.randomBytes(8).toString('hex'),
    path: `/${crypto.randomBytes(16).toString('hex')}`,
    sni,
  };
}

export interface CascadeLink {
  bridgeId: number;
  serverId: number;
  host: string;
  port: number;
  listenPort: number;
  vpnPort: number;
  stubPort: number | null;
  protocol: 'awg' | 'vless';
  secret: CascadeSecret;
  /** Каскад ещё не применён на обеих сторонах (в подписку не выдаётся) */
  pending?: boolean;
}

const LABEL = 'org.dementia.cascade';
const XRAY = '/usr/local/bin/xray';
// Xray 26.10.31: для ограничения отдельных XUDP-датаграмм нужны Freedom finalRules.
export const CASCADE_XRAY_IMAGE = 'ghcr.io/xtls/xray-core@sha256:ceabeac03a89d991d2a247361825c1d1d2e9c91cd5dc010f298c7dc0c2f325c9';

export function cascadeSni(secret: CascadeSecret): string {
  return secret.sni ?? 'dl.google.com';
}

export function cascadeContainer(link: Pick<CascadeLink, 'bridgeId' | 'serverId' | 'secret'>, role: 'bridge' | 'node'): string {
  return `dementia-cascade-${role}-${link.bridgeId}-${link.serverId}-${link.secret.shortId}`;
}

/** Каждый вход на мосту имеет ровно один адрес назначения. На ноде разрешены только эти loopback-порты. */
export function cascadeConfigs(link: CascadeLink): { bridge: string; node: string } {
  const { secret } = link;
  const sni = cascadeSni(secret);
  const transport = {
    network: 'xhttp',
    security: 'reality',
    xhttpSettings: { path: secret.path, mode: 'auto' },
  };
  const ports = link.protocol === 'vless'
    ? [{ network: 'tcp', port: link.vpnPort }]
    : [{ network: 'udp', port: link.vpnPort }, ...(link.stubPort ? [{ network: 'tcp', port: link.stubPort }] : [])];
  const log = { loglevel: 'none' };
  const targets = ports.map(({ network, port }) => ({ network, ip: ['127.0.0.1'], port }));
  return {
    bridge: JSON.stringify({
      log,
      inbounds: ports.map(({ network, port }) => ({
        listen: '0.0.0.0',
        port: link.listenPort,
        protocol: 'dokodemo-door',
        settings: { address: '127.0.0.1', port, network },
      })),
      outbounds: [{
        protocol: 'vless',
        settings: { vnext: [{ address: link.host, port: link.port, users: [{ id: secret.uuid, encryption: 'none' }] }] },
        streamSettings: {
          ...transport,
          realitySettings: { serverName: sni, fingerprint: 'chrome', password: secret.publicKey, shortId: secret.shortId },
        },
      }],
    }),
    node: JSON.stringify({
      log,
      inbounds: [{
        listen: '0.0.0.0',
        port: link.port,
        protocol: 'vless',
        settings: { clients: [{ id: secret.uuid }], decryption: 'none' },
        streamSettings: {
          ...transport,
          realitySettings: { dest: `${sni}:443`, serverNames: [sni], privateKey: secret.privateKey, shortIds: [secret.shortId] },
        },
      }],
      outbounds: [
        { protocol: 'blackhole', tag: 'blocked' },
        {
          protocol: 'freedom',
          tag: 'loopback',
          sendThrough: '127.0.0.1',
          // Freedom блокирует loopback по умолчанию. Ограничиваем и каждую отдельную датаграмму XUDP.
          settings: { finalRules: [...targets.map((target) => ({ action: 'allow', ...target })), { action: 'block' }] },
        },
      ],
      routing: {
        domainStrategy: 'AsIs',
        rules: targets.map((target) => ({ type: 'field', ...target, outboundTag: 'loopback' })),
      },
    }),
  };
}

function owned(name: string): string {
  return `[ "$(docker inspect -f '{{ index .Config.Labels "${LABEL}" }}' "${name}" 2>/dev/null)" = "${name}" ]`;
}

export function cascadeRunning(name: string): string {
  return `${owned(name)} && [ "$(docker inspect -f '{{.State.Status}}' "${name}" 2>/dev/null)" = running ]`;
}

export function cascadePortReachable(host: string, port: number): string {
  return `timeout 5 bash -c 'exec 3<>"/dev/tcp/$1/$2"' -- ${shellQuote(host)} ${shellQuote(port)} 2>/dev/null`;
}

/** Уже открытая DNAT-сессия переживает замену правил iptables. Сбрасываем только записи порта на адресах самого моста. */
export const clearBridgeConntrack = `clear_bridge_conntrack() (
  protocol=$1
  port=$2
  shift 2
  addresses=$(ip -o -4 addr show) || exit 1
  addrs=$(printf '%s\\n' "$addresses" | awk '{ split($4, parts, "/"); print parts[1] }')
  for addr in $addrs; do
    active=$(conntrack -L -p "$protocol" --orig-dst "$addr" --orig-port-dst "$port" "$@" 2>/dev/null) || exit 1
    if [ -n "$active" ]; then
      if ! conntrack -D -p "$protocol" --orig-dst "$addr" --orig-port-dst "$port" "$@" >/dev/null 2>&1; then
        active=$(conntrack -L -p "$protocol" --orig-dst "$addr" --orig-port-dst "$port" "$@" 2>/dev/null) || exit 1
        [ -z "$active" ] || exit 1
      fi
    fi
  done
)`;

/** Проверяем и скачиваем образ отдельно, до любых изменений контейнеров и DNAT. */
export async function prepareCascadeImage(creds: SshCredentials): Promise<void> {
  const image = shellQuote(CASCADE_XRAY_IMAGE);
  const script = [
    'docker info >/dev/null 2>&1 || exit 2',
    `docker image inspect ${image} >/dev/null 2>&1 || timeout -s TERM -k 30 1080 docker pull ${image} >/dev/null 2>&1`,
  ].join('\n');
  let code: number;
  try {
    ({ code } = await SshService.executeCommand(creds, `${SshService.sudo(creds)}sh -c ${shellQuote(script)}`, {
      timeoutMs: 20 * 60 * 1000,
    }));
  } catch (err) {
    throw new Error('Не удалось скачать образ Xray для каскада по SSH', { cause: err });
  }
  if (code === 2) throw new Error('Для каскада нужен запущенный Docker');
  if (code !== 0) throw new Error('Не удалось скачать образ Xray для каскада. Проверьте доступ к реестру образов с сервера.');
}

/** AWG в Docker с опубликованным портом принимает трафик на loopback через docker-proxy. */
export async function requireAwgLoopback(creds: SshCredentials, port: number): Promise<void> {
  const endpoint = port.toString(16).toUpperCase().padStart(4, '0');
  const awk = `$2 ~ /^(00000000|0100007F):${endpoint}$/ && $3 == "00000000:0000" { found = 1 } END { exit !found }`;
  const result = await SshService.executeCommand(creds, `awk ${shellQuote(awk)} /proc/net/udp`, { timeoutMs: 10000 });
  if (result.code !== 0) {
    throw new Error(`AmneziaWG недоступен на 127.0.0.1:${port}/udp. Для опубликованного порта контейнера включите userland-proxy в Docker на ноде.`);
  }
}

/** Файл с секретами передаётся через stdin. Старый контейнер и конфиг возвращаются при сбое запуска. */
export async function applyCascadeContainer(creds: SshCredentials, name: string, config: string): Promise<void> {
  const dir = `/etc/dementia-cascade/${name}`;
  const script = [
    'set -eu',
    'umask 077',
    'docker info >/dev/null 2>&1 || { echo "Для каскада нужен запущенный Docker" >&2; exit 1; }',
    `if docker container inspect "${name}" >/dev/null 2>&1 && ! { ${owned(name)}; }; then echo "Имя контейнера каскада уже занято" >&2; exit 1; fi`,
    `install -d -m 700 "${dir}"`,
    `cd "${dir}"`,
    'trap \'rm -f config.new.json\' EXIT',
    'cat > config.new.json',
    `image=$(docker image inspect -f '{{.Id}}' ${shellQuote(CASCADE_XRAY_IMAGE)} 2>/dev/null) ||
      { echo "Образ Xray для каскада отсутствует" >&2; exit 1; }`,
    `old_image=$(docker inspect -f '{{.Image}}' "${name}" 2>/dev/null || true)`,
    `if [ "$old_image" = "$image" ] && cmp -s config.json config.new.json && { ${cascadeRunning(name)}; }; then exit 0; fi`,
    `docker run --rm --network none --user 0:0 --entrypoint ${XRAY} -v "${dir}/config.new.json:/etc/cascade.json:ro" "$image" run -test -c /etc/cascade.json >/dev/null 2>&1 ||
      { echo "Xray не принял конфигурацию каскада" >&2; exit 1; }`,
    `start() {
      docker run -d --restart unless-stopped --network host --user 0:0 --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE \
        --security-opt no-new-privileges -e XRAY_CONE_DISABLED=true --entrypoint ${XRAY} --label ${LABEL}="${name}" --name "${name}" \
        -v "${dir}/config.json:/etc/cascade.json:ro" "$1" run -c /etc/cascade.json >/dev/null 2>&1
    }`,
    'had_old=0',
    `if ${owned(name)}; then
      cp config.json config.old.json
      docker rm -f "${name}" >/dev/null
      had_old=1
    fi`,
    'mv -f config.new.json config.json',
    `if start "$image" && sleep 1 && [ "$(docker inspect -f '{{.State.Status}} {{.RestartCount}}' "${name}" 2>/dev/null)" = "running 0" ]; then
      rm -f config.old.json
      exit 0
    fi`,
    `if ${owned(name)}; then docker rm -f "${name}" >/dev/null; fi`,
    'rm -f config.json',
    'if [ "$had_old" = 1 ]; then mv -f config.old.json config.json; start "$old_image" || true; fi',
    'echo "Не удалось запустить Xray для каскада. Проверьте, свободен ли порт." >&2',
    'exit 1',
  ].join('\n');
  const result = await SshService.executeCommand(creds, `${SshService.sudo(creds)}sh -c ${shellQuote(script)}`, {
    input: config,
    timeoutMs: 180000,
  });
  if (result.code !== 0) {
    const message = result.stderr.split(/\r?\n/).find((line) => /^(Для каскада|Имя контейнера|Образ Xray|Xray не принял|Не удалось запустить)/.test(line));
    throw new Error(message || 'Не удалось применить конфигурацию Xray каскада по SSH');
  }
}

export async function removeCascadeContainer(creds: SshCredentials, name: string): Promise<void> {
  const dir = `/etc/dementia-cascade/${name}`;
  const script = `set -e
    if [ -d "${dir}" ]; then
      docker info >/dev/null 2>&1
      if ${owned(name)}; then docker rm -f "${name}" >/dev/null; fi
      rm -f "${dir}/config.json" "${dir}/config.old.json" "${dir}/config.new.json"
      rmdir "${dir}"
    fi`;
  const result = await SshService.executeCommand(creds, `${SshService.sudo(creds)}sh -c ${shellQuote(script)}`, { timeoutMs: 60000 });
  if (result.code !== 0) throw new Error('Не удалось снять конфигурацию Xray каскада по SSH');
}
