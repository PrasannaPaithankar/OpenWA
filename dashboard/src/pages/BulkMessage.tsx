import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { read, utils } from 'xlsx';
import { Upload, Play, Square, Pause, RotateCcw, AlertCircle, CheckCircle } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSessionsQuery } from '../hooks/queries';
import { messageApi } from '../services/api';
import { PageHeader } from '../components/PageHeader';
import { useToast } from '../components/Toast';
import { useRole } from '../hooks/useRole';
import './BulkMessage.css';

interface MessageRow {
  id: number;
  contact: string;
  msg: string;
  status: 'pending' | 'sending' | 'completed' | 'failed';
  error?: string;
  mediaType?: string;
  mediaUrl?: string;
}

export function BulkMessage() {
  const { t } = useTranslation();
  useDocumentTitle(t('bulkMessage.title'));
  const { canWrite } = useRole();
  const { error: showError, success: showSuccess } = useToast();
  const { data: allSessions = [] } = useSessionsQuery();
  const sessions = allSessions.filter(s => s.status === 'ready');
  
  const [session, setSession] = useState('');
  const [delay, setDelay] = useState(2000);
  const [rows, setRows] = useState<MessageRow[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [progress, setProgress] = useState(0);
  const [scheduledTime, setScheduledTime] = useState('');
  const [isWaiting, setIsWaiting] = useState(false);
  const [batchId, setBatchId] = useState<string | null>(null);

  const isSendingRef = useRef(isSending);
  const isPausedRef = useRef(isPaused);
  const rowsRef = useRef(rows);
  const delayRef = useRef(delay);
  const waitingRef = useRef(isWaiting);

  useEffect(() => {
    isSendingRef.current = isSending;
    isPausedRef.current = isPaused;
    rowsRef.current = rows;
    delayRef.current = delay;
    waitingRef.current = isWaiting;
  }, [isSending, isPaused, rows, delay, isWaiting]);

  // Wait for the scheduled time only if we want to show a UI countdown
  // But since the backend handles waiting, we can just dispatch immediately
  // and let the backend wait.

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (batchId && isSending) {
      interval = setInterval(async () => {
        try {
          const batch = await messageApi.getBatchStatus(session, batchId);
          if (batch.progress) {
            setProgress(Math.round((batch.progress.sent + batch.progress.failed) / batch.progress.total * 100));
          }
          
          if (batch.results && batch.results.length > 0) {
            setRows(prev => {
              const next = [...prev];
              batch.results.forEach((res: any, idx: number) => {
                if (next[idx]) {
                  next[idx].status = res.status === 'SENT' ? 'completed' : res.status === 'FAILED' ? 'failed' : 'pending';
                  if (res.error) next[idx].error = res.error.message || 'Error';
                }
              });
              return next;
            });
          }

          if (batch.status === 'COMPLETED' || batch.status === 'FAILED' || batch.status === 'CANCELLED') {
            setIsSending(false);
            clearInterval(interval);
            if (batch.status === 'COMPLETED') showSuccess(t('bulkMessage.toasts.sendingComplete'));
          }
        } catch (e) {
          console.error(e);
        }
      }, 2000);
    }
    return () => clearInterval(interval);
  }, [batchId, isSending, session, t, showSuccess]);

  useEffect(() => {
    if (sessions.length > 0 && !session) {
      setSession(sessions[0].id);
    }
  }, [sessions, session]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const data = await file.arrayBuffer();
    const workbook = read(data);
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData: any[] = utils.sheet_to_json(firstSheet);

    if (jsonData.length === 0) return;

    const parsedRows: MessageRow[] = jsonData
      .filter(row => row.contact && (row.msg || row.mediaUrl))
      .map((row, index) => ({
        id: index,
        contact: String(row.contact).replace(/[^0-9]/g, ''),
        msg: row.msg ? String(row.msg) : '',
        mediaType: row.mediaType ? String(row.mediaType).toLowerCase() : undefined,
        mediaUrl: row.mediaUrl ? String(row.mediaUrl) : undefined,
        status: 'pending'
      }));

    if (parsedRows.length === 0) {
      showError(t('bulkMessage.toasts.invalidFile'));
      return;
    }

    setRows(parsedRows);
    setProgress(0);
    setIsSending(false);
    setIsPaused(false);
    setIsWaiting(false);
    setBatchId(null);
  };

  const startSending = async () => {
    if (!session || rows.length === 0) return;
    
    setIsSending(true);
    setIsPaused(false);
    
    const messages = rows.map(r => {
      const type = r.mediaType || 'text';
      const content: any = {};
      if (type === 'text') {
        content.text = r.msg;
      } else {
        content[type] = { url: r.mediaUrl };
        if (r.msg) content.caption = r.msg;
      }
      return { chatId: r.contact + '@c.us', type, content };
    });

    const options: any = { delayBetweenMessages: delay, stopOnError: false };
    if (scheduledTime) {
      options.scheduledAt = new Date(scheduledTime).toISOString();
    }

    try {
      const res = await messageApi.sendBulk(session, { messages, options });
      setBatchId(res.batchId);
      showSuccess(`Dispatched to backend! You can safely close this tab.`);
    } catch (e) {
      showError('Failed to dispatch bulk messages');
      setIsSending(false);
    }
  };

  const pauseSending = () => setIsPaused(true);
  const resumeSending = () => setIsPaused(false);
  const stopSending = async () => {
    setIsSending(false);
    setIsPaused(false);
    setIsWaiting(false);
    if (batchId) {
      try {
        await messageApi.cancelBatch(session, batchId);
        showSuccess('Batch cancelled on server');
      } catch (e) {}
    }
  };
  const resetQueue = () => {
    setRows(prev => prev.map(r => ({ ...r, status: 'pending', error: undefined })));
    setProgress(0);
    setIsSending(false);
    setIsPaused(false);
    setIsWaiting(false);
    setBatchId(null);
  };

  const completedCount = rows.filter(r => r.status === 'completed').length;
  const failedCount = rows.filter(r => r.status === 'failed').length;

  return (
    <div className="bulk-message-page">
      <PageHeader title={t('bulkMessage.title')} subtitle={t('bulkMessage.subtitle')} />
      
      <div className="bulk-content">
        <div className="control-panel">
          <div className="form-group">
            <label>{t('bulkMessage.selectSession')}</label>
            <select value={session} onChange={e => setSession(e.target.value)} disabled={isSending}>
              {sessions.length === 0 && <option value="">{t('bulkMessage.noSession')}</option>}
              {sessions.map(s => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.phone || 'No phone'})
                </option>
              ))}
            </select>
          </div>

          <div className="form-group">
            <label>{t('bulkMessage.uploadFile')}</label>
            <div className="upload-box">
              <input 
                type="file" 
                accept=".xlsx, .xls, .csv" 
                onChange={handleFileUpload}
                disabled={isSending}
                id="file-upload"
              />
              <label htmlFor="file-upload" className="upload-label">
                <Upload size={24} />
                <span>Upload .xlsx, .xls, or .csv</span>
              </label>
            </div>
          </div>

          <div className="form-group">
            <label>{t('bulkMessage.delayLabel')}</label>
            <input 
              type="number" 
              value={delay} 
              onChange={e => setDelay(Number(e.target.value))}
              min={1000}
              step={500}
              disabled={isSending}
            />
          </div>

          <div className="form-group">
            <label>Scheduled Start Time</label>
            <input 
              type="datetime-local" 
              value={scheduledTime} 
              onChange={e => setScheduledTime(e.target.value)} 
              disabled={isSending}
            />
            <span className="hint" style={{ fontSize: '0.8rem', color: '#666', marginTop: '4px', display: 'block' }}>Leave empty to start immediately</span>
          </div>

          <div className="action-buttons">
            {!isSending ? (
              <button 
                className="btn-primary" 
                onClick={startSending} 
                disabled={!canWrite || !session || rows.filter(r => r.status === 'pending').length === 0}
              >
                <Play size={18} /> {t('bulkMessage.start')}
              </button>
            ) : isPaused ? (
              <button className="btn-primary" onClick={resumeSending}>
                <Play size={18} /> {t('bulkMessage.resume')}
              </button>
            ) : (
              <button className="btn-warning" onClick={pauseSending}>
                <Pause size={18} /> {t('bulkMessage.pause')}
              </button>
            )}
            
            <button 
              className="btn-danger" 
              onClick={stopSending} 
              disabled={!isSending && !batchId}
            >
              <Square size={18} /> {batchId ? 'Cancel Batch' : t('bulkMessage.stop')}
            </button>
            
            <button 
              className="btn-secondary" 
              onClick={resetQueue} 
              disabled={isSending || rows.length === 0}
            >
              <RotateCcw size={18} /> Reset
            </button>
          </div>

          {batchId && isSending && progress === 0 && scheduledTime && (
            <div className="info-box" style={{ marginTop: '16px', padding: '10px', background: '#FEF3C7', color: '#B45309', borderRadius: '4px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>Batch dispatched. Waiting for scheduled time... (You can close this tab)</span>
            </div>
          )}

          {rows.length > 0 && (
            <div className="progress-section">
              <div className="progress-stats">
                <span>{t('bulkMessage.progress')}: {progress}%</span>
                <span>
                  <CheckCircle size={14} className="icon-success" /> {completedCount}
                  {'  '}
                  <AlertCircle size={14} className="icon-error" /> {failedCount}
                </span>
              </div>
              <div className="progress-bar-container">
                <div className="progress-bar" style={{ width: `${progress}%` }}></div>
              </div>
            </div>
          )}
        </div>

        <div className="table-panel">
          <table className="bulk-table">
            <thead>
              <tr>
                <th>{t('bulkMessage.columns.contact')}</th>
                <th>{t('bulkMessage.columns.msg')}</th>
                <th>{t('bulkMessage.columns.status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id} className={`status-${row.status}`}>
                  <td>{row.contact}</td>
                  <td className="msg-cell">{row.msg}</td>
                  <td>
                    <span className={`status-badge ${row.status}`}>
                      {t(`bulkMessage.${row.status}`)}
                      {row.error && <span className="error-tooltip" title={row.error}>?</span>}
                    </span>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={3} className="empty-state">
                    Upload a file to preview the messages
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
