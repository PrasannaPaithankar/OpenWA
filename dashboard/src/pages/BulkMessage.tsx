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

  const isSendingRef = useRef(isSending);
  const isPausedRef = useRef(isPaused);
  const rowsRef = useRef(rows);
  const delayRef = useRef(delay);

  useEffect(() => {
    isSendingRef.current = isSending;
    isPausedRef.current = isPaused;
    rowsRef.current = rows;
    delayRef.current = delay;
  }, [isSending, isPaused, rows, delay]);

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
      .filter(row => row.contact && row.msg)
      .map((row, index) => ({
        id: index,
        contact: String(row.contact).replace(/[^0-9]/g, ''),
        msg: String(row.msg),
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
  };

  const processQueue = async () => {
    if (!session) return;
    
    let currentIdx = rowsRef.current.findIndex(r => r.status === 'pending');
    
    while (currentIdx !== -1 && isSendingRef.current) {
      if (isPausedRef.current) {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }

      const currentRow = rowsRef.current[currentIdx];
      
      setRows(prev => prev.map(r => r.id === currentRow.id ? { ...r, status: 'sending' } : r));
      
      try {
        const chatId = currentRow.contact + '@c.us';
        await messageApi.sendText(session, chatId, currentRow.msg);
        setRows(prev => prev.map(r => r.id === currentRow.id ? { ...r, status: 'completed' } : r));
      } catch (err) {
        setRows(prev => prev.map(r => r.id === currentRow.id ? { ...r, status: 'failed', error: err instanceof Error ? err.message : 'Unknown error' } : r));
      }
      
      setProgress(Math.round(((currentIdx + 1) / rowsRef.current.length) * 100));

      if (currentIdx < rowsRef.current.length - 1 && isSendingRef.current && !isPausedRef.current) {
        await new Promise(resolve => setTimeout(resolve, delayRef.current));
      }
      
      currentIdx = rowsRef.current.findIndex(r => r.status === 'pending');
    }

    if (currentIdx === -1 && isSendingRef.current) {
      setIsSending(false);
      showSuccess(t('bulkMessage.toasts.sendingComplete'));
    }
  };

  const startSending = () => {
    if (!session || rows.length === 0) return;
    setIsSending(true);
    setIsPaused(false);
    // Let state update before starting the loop
    setTimeout(() => {
      isSendingRef.current = true;
      isPausedRef.current = false;
      processQueue();
    }, 100);
  };

  const pauseSending = () => setIsPaused(true);
  const resumeSending = () => setIsPaused(false);
  const stopSending = () => {
    setIsSending(false);
    setIsPaused(false);
  };
  const resetQueue = () => {
    setRows(prev => prev.map(r => ({ ...r, status: 'pending', error: undefined })));
    setProgress(0);
    setIsSending(false);
    setIsPaused(false);
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
              disabled={!isSending}
            >
              <Square size={18} /> {t('bulkMessage.stop')}
            </button>
            
            <button 
              className="btn-secondary" 
              onClick={resetQueue} 
              disabled={isSending || rows.length === 0}
            >
              <RotateCcw size={18} /> Reset
            </button>
          </div>

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
