import React, { useState } from 'react';
import { COMMON_COUNTRIES, countryFlag, countryName } from '../utils';

const OTHER = '__other';

/**
 * Выбор страны (двухбуквенный код ISO): частые страны списком, любая другая — вводом кода.
 */
export const CountrySelect: React.FC<{
  value: string;
  onChange: (code: string) => void;
  /** Подпись пустого значения; без неё страна обязательна */
  emptyLabel?: string;
  label?: string;
  className?: string;
}> = ({ value, onChange, emptyLabel, label, className }) => {
  const [custom, setCustom] = useState(Boolean(value) && !COMMON_COUNTRIES.includes(value));
  const selected = custom ? OTHER : value;
  return (
    <div className="flex items-center gap-2">
      <select
        aria-label={label}
        value={selected}
        required={!emptyLabel}
        onChange={(e) => {
          if (e.target.value === OTHER) {
            setCustom(true);
            onChange('');
          } else {
            setCustom(false);
            onChange(e.target.value);
          }
        }}
        className={className}
      >
        {emptyLabel !== undefined ? <option value="">{emptyLabel}</option> : <option value="" disabled>Выберите страну</option>}
        {COMMON_COUNTRIES.map((code) => (
          <option key={code} value={code}>
            {countryFlag(code)} {countryName(code)}
          </option>
        ))}
        <option value={OTHER}>Другая страна…</option>
      </select>
      {custom && (
        <input
          aria-label={label ? 'Код страны' : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value.trim().toLowerCase().slice(0, 2))}
          placeholder="код"
          pattern="[a-zA-Z]{2}"
          title="Двухбуквенный код страны ISO 3166-1 (например, ru)"
          required={!emptyLabel}
          className={`${className} w-16`}
        />
      )}
    </div>
  );
};
