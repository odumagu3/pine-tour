import React from 'react';
import { UserProfile, Transaction } from '../types.js';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { TrendingUp, BarChart3, Target, Calendar, Award, Wallet, Trophy, Ticket } from 'lucide-react';
import { formatNaira } from '../currency.js';

interface DashboardStatsProps {
  profile: UserProfile;
}

export default function DashboardStats({ profile }: DashboardStatsProps) {
  // Compute Win Rate
  const winRate = profile.gamesPlayed > 0 
    ? Math.round((profile.gamesWon / profile.gamesPlayed) * 100) 
    : 0;

  // Transform transactions into a cumulative earnings progression chart data
  // We take completed deposits/wins as plus, bets/withdrawals as minus
  // Filter for 'win', 'bet', 'deposit', 'withdrawal' to map over time
  const getChartData = () => {
    const reversedHistory = [...profile.history].reverse();
    let rollingEarnings = 0;
    
    // We want to track purely earnings (winnings minus bets) or total balance progress. Let's track Balance progression
    const data = reversedHistory.map((tx, idx) => {
      if (tx.type === 'win') {
        rollingEarnings += tx.amount;
      } else if (tx.type === 'bet') {
        rollingEarnings -= tx.amount;
      }
      return {
        name: `Tx ${idx + 1}`,
        balance: tx.balanceAfter,
        earnings: rollingEarnings,
        date: new Date(tx.timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      };
    });

    // Fallback if no history exists yet
    if (data.length === 0) {
      return [
        { name: 'Start', balance: 0, earnings: 0, date: 'Welcome' }
      ];
    }

    return data;
  };

  const chartData = getChartData();

  return (
    <div className="space-y-8 w-full max-w-6xl mx-auto p-2" id="dashboard_stats_panel">
      {/* 1. BENTO GRID OF CARDS */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {/* Total Winnings */}
        <div className="bg-dark-card border border-slate-800 rounded-2xl p-5 shadow-lg flex flex-col justify-between relative overflow-hidden">
          <div className="absolute top-0 right-0 w-16 h-16 bg-neon-green/5 rounded-full blur-xl" />
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono text-slate-400">Total Profits</span>
            <Trophy className="w-4 h-4 text-neon-green" />
          </div>
          <div>
            <span className="text-2xl font-bold font-display text-neon-green neon-glow-green">{formatNaira(profile.totalEarnings)}</span>
            <span className="text-[9px] font-mono text-slate-500 block uppercase mt-1">Sponsor Prize Winnings</span>
          </div>
        </div>

        {/* Ledger balance */}
        <div className="bg-dark-card border border-slate-800 rounded-2xl p-5 shadow-lg flex flex-col justify-between relative overflow-hidden">
          <div className="absolute top-0 right-0 w-16 h-16 bg-neon-cyan/5 rounded-full blur-xl" />
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono text-slate-400">Wallet Balance</span>
            <Wallet className="w-4 h-4 text-neon-cyan" />
          </div>
          <div>
            <span className="text-2xl font-bold font-display text-neon-cyan neon-glow-cyan">{formatNaira(profile.balance)}</span>
            <span className="text-[9px] font-mono text-slate-500 block uppercase mt-1">Withdrawable Cash</span>
          </div>
        </div>

        {/* Win Rate */}
        <div className="bg-dark-card border border-slate-800 rounded-2xl p-5 shadow-lg flex flex-col justify-between relative overflow-hidden">
          <div className="absolute top-0 right-0 w-16 h-16 bg-neon-purple/5 rounded-full blur-xl" />
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono text-slate-400">Win Ratio</span>
            <Target className="w-4 h-4 text-neon-purple" />
          </div>
          <div>
            <span className="text-2xl font-bold font-display text-neon-purple neon-glow-purple">{winRate}%</span>
            <span className="text-[9px] font-mono text-slate-500 block uppercase mt-1">{profile.gamesWon} Wins / {profile.gamesPlayed} Matches</span>
          </div>
        </div>

        {/* Tournament Tickets */}
        <div className="bg-dark-card border border-slate-800 rounded-2xl p-5 shadow-lg flex flex-col justify-between relative overflow-hidden">
          <div className="absolute top-0 right-0 w-16 h-16 bg-amber-400/5 rounded-full blur-xl" />
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono text-slate-400">Tickets</span>
            <Ticket className="w-4 h-4 text-amber-400" />
          </div>
          <div>
            <span className="text-2xl font-bold font-display text-amber-400">{profile.tickets}</span>
            <span className="text-[9px] font-mono text-slate-500 block uppercase mt-1">
              {profile.freeGameUsed ? 'Tournament Entries' : '+ 1 Free Game'}
            </span>
          </div>
        </div>
      </div>

      {/* 2. AREA PROGRESSION CHART */}
      <div className="bg-dark-card border border-slate-800 rounded-2xl p-6 shadow-xl">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-md font-bold font-display text-white tracking-tight">Ledger Growth Performance</h2>
            <p className="text-xs text-slate-500 font-mono">Real-time ledger balance progression across past sessions</p>
          </div>
          <div className="flex items-center gap-2 text-xs font-mono bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-slate-400">
            <TrendingUp className="w-4 h-4 text-neon-green" />
            <span>Audited Logs</span>
          </div>
        </div>

        {/* CHART VIEWPORT */}
        <div className="h-[280px] w-full bg-[#050505]/40 p-2 rounded-xl border border-white/5 font-mono text-xs">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                <linearGradient id="colorBalance" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.2}/>
                  <stop offset="95%" stopColor="#22d3ee" stopOpacity={0}/>
                </linearGradient>
                <linearGradient id="colorEarnings" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#34d399" stopOpacity={0.2}/>
                  <stop offset="95%" stopColor="#34d399" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="date" stroke="#6b7280" fontSize={10} tickLine={false} />
              <YAxis stroke="#6b7280" fontSize={10} tickLine={false} />
              <Tooltip 
                contentStyle={{ backgroundColor: '#0a0a0a', borderColor: 'rgba(255,255,255,0.08)', borderRadius: '12px' }}
                labelStyle={{ color: '#e5e7eb', fontFamily: 'monospace' }}
                itemStyle={{ fontFamily: 'monospace' }}
              />
              <Area 
                type="monotone" 
                dataKey="balance" 
                stroke="#22d3ee" 
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorBalance)"
                name="Wallet Balance (₦)"
              />
              <Area 
                type="monotone" 
                dataKey="earnings" 
                stroke="#34d399" 
                strokeWidth={1.5}
                fillOpacity={0.5}
                fill="url(#colorEarnings)"
                name="Net Winnings (₦)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* 3. SIMULATED RECORDED TOURNAMENT SUMMARIES */}
      <div className="bg-dark-card border border-slate-800 rounded-2xl p-6 shadow-xl">
        <h2 className="text-md font-bold font-display text-white mb-1 tracking-tight flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-neon-purple" />
          Tournament & Ticket Activity
        </h2>
        <p className="text-xs text-slate-500 font-mono mb-4">Recent sponsor prize wins and ticket pack purchases</p>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-slate-800 font-mono text-[10px] text-slate-400 uppercase">
                <th className="py-3 px-4">Activity</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4">Date</th>
                <th className="py-3 px-4 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="font-mono text-xs text-slate-300 divide-y divide-slate-900/50">
              {profile.history.filter(tx => tx.type === 'win' || tx.type === 'ticket').length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-slate-500">
                    No tournaments played yet. Head to the Play Arena and win a sponsor's cash prize!
                  </td>
                </tr>
              ) : (
                profile.history
                  .filter(tx => tx.type === 'win' || tx.type === 'ticket')
                  .slice(0, 6)
                  .map((tx) => {
                    const isWin = tx.type === 'win';
                    return (
                      <tr key={`round-row-${tx.id}`} className="hover:bg-slate-900/30 transition-all">
                        <td className="py-3 px-4 font-semibold text-white max-w-[220px] truncate">
                          {tx.method}
                        </td>
                        <td className="py-3 px-4">
                          <span className={`text-[10px] px-2 py-0.5 rounded font-bold uppercase ${isWin ? 'bg-neon-green/5 text-neon-green' : 'bg-neon-purple/5 text-neon-purple'}`}>
                            {isWin ? 'Prize' : 'Tickets'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-400">
                          {new Date(tx.timestamp).toLocaleDateString()}
                        </td>
                        <td className={`py-3 px-4 text-right font-bold ${isWin ? 'text-neon-green' : 'text-neon-pink'}`}>
                          {isWin ? `+${formatNaira(tx.amount)}` : `-${formatNaira(tx.amount)}`}
                        </td>
                      </tr>
                    );
                  })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
