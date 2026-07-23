import React, { useState } from 'react';
import { UserProfile } from '../types.js';
import { ShieldAlert, Download, Trash2, Check, Lock, CheckCircle, FileJson } from 'lucide-react';
import { apiUrl } from '../config.js';

interface PrivacyPortalProps {
  profile: UserProfile;
  onResetData: () => void;
}

export default function PrivacyPortal({ profile, onResetData }: PrivacyPortalProps) {
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [erased, setErased] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Trigger JSON file download for GDPR compliance
  const handleExportData = async () => {
    setExporting(true);
    await new Promise(r => setTimeout(r, 1000)); // Mock preparation delay

    try {
      const response = await fetch(apiUrl(`/api/profile/export`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: profile.email }),
      });
      const data = await response.json();
      
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `neon_ludo_privacy_export_${profile.email.replace(/@/, '_')}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Data export failed', e);
    } finally {
      setExporting(false);
    }
  };

  // Erase account data from the server
  const handleErasure = async () => {
    try {
      const response = await fetch(apiUrl(`/api/profile/delete`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: profile.email }),
      });

      if (response.ok) {
        setErased(true);
        onResetData();
        setTimeout(() => {
          setErased(false);
          setDeleteConfirm(false);
        }, 3000);
      }
    } catch (e) {
      console.error('Data erasure failed', e);
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-8 w-full max-w-6xl mx-auto p-2" id="privacy_gdpr_portal">
      
      {/* EXPLANATORY DISCLOSURES */}
      <div className="md:col-span-7 bg-dark-card border border-slate-800 rounded-2xl p-6 shadow-xl space-y-6">
        <div>
          <span className="text-[10px] uppercase font-mono tracking-wider px-2 py-0.5 rounded bg-neon-purple/10 border border-neon-purple/30 text-neon-purple">
            Regulatory Compliance
          </span>
          <h2 className="text-xl font-bold font-display text-white mt-2 tracking-tight">Data Privacy & GDPR Rights</h2>
          <p className="text-xs text-slate-500 font-mono mt-1">Transparency on our fully-compliant ledger and account logging architecture</p>
        </div>

        <div className="space-y-4 font-mono text-xs text-slate-300 leading-relaxed">
          <div className="p-4 bg-slate-950 rounded-xl border border-slate-900 space-y-2">
            <h4 className="text-white font-semibold flex items-center gap-2">
              <Lock className="w-4 h-4 text-neon-purple" />
              1. What personal data do we store?
            </h4>
            <ul className="list-disc pl-4 space-y-1 text-slate-400">
              <li>Email address: Used as your distinct account identifier.</li>
              <li>Financial Ledger: Tracks mock deposits, bets, wins, and withdrawals.</li>
              <li>Compliance Documents: Cryptographic hashes of your legal name and ID details.</li>
              <li>Career metrics: Career peak rolls, matches played, and win/loss records.</li>
            </ul>
          </div>

          <div className="p-4 bg-slate-950 rounded-xl border border-slate-900 space-y-2">
            <h4 className="text-white font-semibold flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-neon-purple" />
              2. Encrypted Document Safety (KYC)
            </h4>
            <p className="text-slate-400">
              Your biometric verification details are processed on secure mock sandboxes. ID numbers are immediately masked (e.g. `******456A`) upon ingestion to prevent identity leakage. Full raw scans are never archived.
            </p>
          </div>

          <div className="p-4 bg-slate-950 rounded-xl border border-slate-900 space-y-2">
            <h4 className="text-white font-semibold flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-neon-purple" />
              3. Fair Play and Anti-Cheat logs
            </h4>
            <p className="text-slate-400">
              For anti-fraud security, standard gameplay coordinates, turn timing, and dice rolls are cross-referenced directly by server-authoritative states. No local cookie tracking or cross-device advertising scripts are active.
            </p>
          </div>
        </div>
      </div>

      {/* ACTION RIGHT BUTTONS */}
      <div className="md:col-span-5 space-y-6">
        
        {/* RIGHT TO DATA PORTABILITY (EXPORT) */}
        <div className="bg-dark-card border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div className="p-2.5 rounded-lg bg-neon-cyan/5 border border-neon-cyan/20 w-fit">
            <FileJson className="w-6 h-6 text-neon-cyan" />
          </div>
          <div>
            <h3 className="text-sm font-semibold font-display text-white uppercase tracking-wide">Data Portability Right</h3>
            <p className="text-xs text-slate-500 font-mono mt-1 leading-relaxed">
              Retrieve a full, machine-readable JSON archive containing your transaction logs, profile ledger, and kyc status.
            </p>
          </div>
          <button
            onClick={handleExportData}
            disabled={exporting}
            className="w-full py-2.5 bg-slate-900 border border-slate-800 hover:border-neon-cyan/40 hover:bg-neon-cyan/5 transition-all text-xs font-mono text-slate-300 hover:text-white rounded-lg flex items-center justify-center gap-2"
          >
            {exporting ? (
              <span>Preparing Archive...</span>
            ) : (
              <>
                <Download className="w-4 h-4" />
                Export Profile JSON (GDPR)
              </>
            )}
          </button>
        </div>

        {/* RIGHT TO ERASURE (DELETE/RESET) */}
        <div className="bg-dark-card border border-slate-800 rounded-2xl p-6 shadow-xl space-y-4">
          <div className="p-2.5 rounded-lg bg-neon-pink/5 border border-neon-pink/20 w-fit">
            <Trash2 className="w-6 h-6 text-neon-pink" />
          </div>
          <div>
            <h3 className="text-sm font-semibold font-display text-white uppercase tracking-wide">Right to be Forgotten</h3>
            <p className="text-xs text-slate-500 font-mono mt-1 leading-relaxed">
              Instantly purge your entire financial ledger, transactions, and verification records from our server. This action is irreversible.
            </p>
          </div>

          {erased ? (
            <div className="p-3 bg-neon-green/10 border border-neon-green/30 text-neon-green rounded-lg text-xs font-mono text-center">
              ✓ Personal Profile Purged! Re-initializing standard welcome bonus ledger...
            </div>
          ) : !deleteConfirm ? (
            <button
              onClick={() => setDeleteConfirm(true)}
              className="w-full py-2.5 bg-red-950/20 border border-red-500/30 text-red-400 hover:bg-red-500 hover:text-white hover:border-red-500 transition-all text-xs font-mono rounded-lg flex items-center justify-center gap-2"
            >
              Request Account Erasure
            </button>
          ) : (
            <div className="space-y-3">
              <div className="p-3 bg-red-950/40 border border-red-500/40 rounded-lg text-[11px] text-red-400 font-mono text-center">
                Are you absolutely sure? This will wipe your balance, earnings, and KYC files.
              </div>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={handleErasure}
                  className="py-2 bg-red-600 text-white font-mono text-xs font-semibold rounded hover:bg-red-700"
                >
                  Confirm Delete
                </button>
                <button
                  onClick={() => setDeleteConfirm(false)}
                  className="py-2 bg-slate-900 border border-slate-800 text-slate-300 font-mono text-xs rounded hover:text-white"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
