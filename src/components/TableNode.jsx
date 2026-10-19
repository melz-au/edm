import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import {
  TABLE_HANDLE_BOTTOM,
  TABLE_HANDLE_IN,
  TABLE_HANDLE_OUT,
  TABLE_HANDLE_TOP,
  visibleColumns,
} from '../lib/layout.js';

const TYPE_BADGE = {
  VIEW: 'view',
  MATERIALIZED_VIEW: 'mv',
  STREAMING_TABLE: 'st',
  EXTERNAL: 'ext',
  FOREIGN: 'foreign',
  EXTERNAL_REFERENCE: 'ref',
};

function TableNode({ data }) {
  const { table, columnMode, level, highlightColumns, categorical, pii, dq } = data;
  const columns = visibleColumns(table, columnMode);
  const hidden = table.columns.length - columns.length;
  const badge = TYPE_BADGE[table.type];

  return (
    <div className={`table-node level-${level}${table.external ? ' external' : ''}`}>
      <Handle type="target" position={Position.Top} id={TABLE_HANDLE_TOP} className="erd-handle" />
      <Handle type="source" position={Position.Bottom} id={TABLE_HANDLE_BOTTOM} className="erd-handle" />
      <div className="table-node__header" title={[table.comment, table.id].filter(Boolean).join('\n')}>
        <Handle type="target" position={Position.Left} id={TABLE_HANDLE_IN} className="erd-handle" />
        <span className="table-node__name">{table.label ?? table.name}</span>
        {badge && level === 'physical' && <span className="table-node__badge">{badge}</span>}
        {table.external && <span className="table-node__schema">{table.schema}</span>}
        {dq && (
          <span
            className={`table-node__dq ${dq.score >= 0.98 ? 'ok' : dq.score >= 0.9 ? 'warn' : 'bad'}`}
            title={`Data quality: ${dq.rules} rules, ${dq.failing} failing`}
          >
            DQ {Math.round(dq.score * 100)}%
          </span>
        )}
        <Handle type="source" position={Position.Right} id={TABLE_HANDLE_OUT} className="erd-handle" />
      </div>
      {columns.map((c) => (
        <div
          key={c.name}
          className={`table-node__row${highlightColumns?.has(c.name) ? ' highlight' : ''}`}
          title={[c.comment, level !== 'physical' && `${c.name}: ${c.type}`].filter(Boolean).join('\n') || undefined}
        >
          <Handle type="target" position={Position.Left} id={`${c.name}-in`} className="erd-handle" />
          <span className="table-node__keys">
            {c.pk && <span className="key pk" title="Primary key">PK</span>}
            {c.fk && <span className="key fk" title="Foreign key">FK</span>}
            {pii?.has(c.name) && (
              <span className={`key pii ${pii.get(c.name).sensitivity}`} title={`Personal data: ${pii.get(c.name).label}`}>PII</span>
            )}
            {categorical?.has(c.name) && !pii?.has(c.name) && <span className="key cat" title="Categorical field">CAT</span>}
          </span>
          <span className={`table-node__col${c.nullable ? '' : ' required'}`}>{c.label ?? c.name}</span>
          <span className="table-node__type">{c.displayType ?? c.type}</span>
          <Handle type="source" position={Position.Right} id={`${c.name}-out`} className="erd-handle" />
        </div>
      ))}
      {hidden > 0 && columnMode !== 'none' && (
        <div className="table-node__more">+{hidden} more column{hidden === 1 ? '' : 's'}</div>
      )}
    </div>
  );
}

export default memo(TableNode);
