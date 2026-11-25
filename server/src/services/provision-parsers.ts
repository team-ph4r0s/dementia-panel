export interface OperationResult {
  success: boolean;
  error?: string;
}

export interface DetectedContainer {
  name: string;
  image: string;
  running: boolean;
  confPath: string | null;
  tool: 'awg' | 'wg';
  managedBy: 'demension' | 'amnezia';
  config: string | null;
  clientNames: Record<string, string>;
}

export interface ScanResult {
  /** Найден работающий контейнер с конфигурацией, который можно подключить без установки */
  found: boolean;
  containers: { name: string; image: string; running: boolean; managedBy: string }[];
  message: string;
  adopted?: {
    container: string;
    managedBy: string;
    awgVersion: number;
    port: number;
    subnet: string;
    importedPeers: number;
    skippedPeers: number;
  };
}

export interface NodeInfo {
  awg_go: string | null;
  awg_tools: string | null;
  image: string | null;
  image_created: string | null;
}

export interface XrayStatItem {
  email: string;
  uplink: number;
  downlink: number;
}

/**
 * Разбор вывода скрипта сканирования (маркеры ---CONTAINER / ---CONF / ---TOOL / ---CLIENTS / ---DEMENTIA)
 */
export function parseScanOutput(output: string): DetectedContainer[] {
  const containers: DetectedContainer[] = [];
  let current: DetectedContainer | null = null;
  let mode: 'conf' | 'clients' | null = null;
  let buffer: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (mode) {
      if ((mode === 'conf' && line === '---ENDCONF') || (mode === 'clients' && line === '---ENDCLIENTS')) {
        if (current && mode === 'conf') current.config = buffer.join('\n');
        if (current && mode === 'clients') {
          try {
            const table = JSON.parse(buffer.join('\n'));
            for (const entry of Array.isArray(table) ? table : []) {
              const name = entry?.userData?.clientName;
              if (entry?.clientId && typeof name === 'string' && name.trim()) current.clientNames[entry.clientId] = name.trim();
            }
          } catch {
            // clientsTable не JSON — имена не импортируются
          }
        }
        mode = null;
        buffer = [];
      } else {
        buffer.push(line);
      }
      continue;
    }

    if (line.startsWith('---CONTAINER ')) {
      const [name, image, running] = line.slice('---CONTAINER '.length).split('|');
      current = {
        name,
        image: image || '',
        running: running === 'true',
        confPath: null,
        tool: 'awg',
        managedBy: 'amnezia',
        config: null,
        clientNames: {},
      };
      containers.push(current);
    } else if (current && line.startsWith('---CONF ')) {
      current.confPath = line.slice('---CONF '.length).trim();
      mode = 'conf';
    } else if (current && line.startsWith('---TOOL ')) {
      current.tool = line.includes('awg') ? 'awg' : 'wg';
    } else if (current && line === '---CLIENTS') {
      mode = 'clients';
    } else if (current && line === '---DEMENTIA') {
      current.managedBy = 'demension';
    }
  }
  return containers;
}

/**
 * Разбор вывода команды версий (строки IMAGE / CREATED / GO / TOOLS). Вывод приходит с ноды и показывается в интерфейсе,
 * поэтому берутся только значения строго известного формата.
 */
export function parseNodeInfo(output: string): NodeInfo {
  const line = (key: string) => new RegExp(`^${key} (.*)$`, 'm').exec(output)?.[1]?.trim() ?? '';
  const go = /amneziawg-go\s+v?(\d[\w.+-]{0,40})/.exec(line('GO'))?.[1] ?? null;
  const tools = /(amneziawg-tools|wireguard-tools)\s+v?(\d[\w.+-]{0,40})/.exec(line('TOOLS'));
  const xray = /Xray\s+v?(\d[\w.+-]{0,40})/i.exec(line('XRAY'));
  const image = /^[\w./:@-]{1,200}$/.test(line('IMAGE')) ? line('IMAGE') : null;
  const created = line('CREATED');
  return {
    awg_go: go,
    awg_tools: tools ? `${tools[1]} ${tools[2]}` : (xray ? `Xray ${xray[1]}` : null),
    image,
    image_created: /^\d{4}-\d{2}-\d{2}T/.test(created) && !Number.isNaN(Date.parse(created)) ? new Date(created).toISOString() : null,
  };
}

/**
 * Разбор вывода `xray api statsquery -s 127.0.0.1:10085 -reset`.
 * Вывод ноды — недоверенные данные: строгая фильтрация формата имён user>>><email_or_uuid>>>>traffic>>>uplink|downlink
 * и числовых значений байтов.
 */
export function parseXrayStats(output: string): XrayStatItem[] {
  const map = new Map<string, { uplink: number; downlink: number }>();
  if (!output || typeof output !== 'string') return [];

  const getOrCreate = (email: string) => {
    let entry = map.get(email);
    if (!entry) {
      entry = { uplink: 0, downlink: 0 };
      map.set(email, entry);
    }
    return entry;
  };

  const parseItem = (name: unknown, val: unknown) => {
    if (typeof name !== 'string') return;
    const match = /^user>>>([a-zA-Z0-9_-]{1,64})>>>traffic>>>(uplink|downlink)$/.exec(name.trim());
    if (!match) return;
    const email = match[1];
    const bytes = typeof val === 'number' ? val : parseInt(String(val), 10);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) return;

    const entry = getOrCreate(email);
    if (match[2] === 'uplink') {
      entry.uplink += bytes;
    } else {
      entry.downlink += bytes;
    }
  };

  let parsedJson = false;
  try {
    const trimmed = output.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const data = JSON.parse(trimmed);
      const items = Array.isArray(data?.stat) ? data.stat : Array.isArray(data) ? data : null;
      if (items) {
        for (const item of items) {
          parseItem(item?.name, item?.value);
        }
        parsedJson = true;
      }
    }
  } catch {
    // Не JSON — продолжаем разбор регулярным выражением
  }

  if (!parsedJson) {
    const re = /user>>>([a-zA-Z0-9_-]{1,64})>>>traffic>>>(uplink|downlink)[\s":=]+(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(output)) !== null) {
      const email = m[1];
      const dir = m[2];
      const bytes = parseInt(m[3], 10);
      if (Number.isSafeInteger(bytes) && bytes > 0) {
        const entry = getOrCreate(email);
        if (dir === 'uplink') entry.uplink += bytes;
        else entry.downlink += bytes;
      }
    }
  }

  return Array.from(map.entries()).map(([email, traffic]) => ({
    email,
    uplink: traffic.uplink,
    downlink: traffic.downlink,
  }));
}
