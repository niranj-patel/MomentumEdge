import { useState, useEffect, useCallback } from "react";

const STORAGE_KEY = "momentum_portfolio_v6";

const defaultPortfolio = [
  { id:1, ticker:"HPE",  totalShares:0, avgCost:0, currentPrice:0, supertrend:"positive", notes:"", addedDate:"2026-01-01", momentum:"high", profitBookings:[] },
  { id:2, ticker:"AVGO", totalShares:0, avgCost:0, currentPrice:0, supertrend:"positive", notes:"", addedDate:"2026-01-01", momentum:"high", profitBookings:[] },
  { id:3, ticker:"BE",   totalShares:0, avgCost:0, currentPrice:0, supertrend:"positive", notes:"", addedDate:"2026-01-01", momentum:"high", profitBookings:[] },
  { id:4, ticker:"MRVL", totalShares:0, avgCost:0, currentPrice:0, supertrend:"positive", notes:"", addedDate:"2026-01-01", momentum:"high", profitBookings:[] },
  { id:5, ticker:"CRDO", totalShares:0, avgCost:0, currentPrice:0, supertrend:"positive", notes:"", addedDate:"2026-01-01", momentum:"high", profitBookings:[] },
];

// cashBuffer = money sitting uninvested (separate from stock values)
const defaultSettings = {
  cashBuffer:      1000,   // cash sitting outside positions — you update this manually
  maxPositionPct:  20,
  minPositionPct:  8,
  cashReservePct:  10,
  maxPositions:    7,
  sipAmount:       500,
  pb1TriggerPct:   40,
  pb1SellQtyPct:   40,
  pb2TriggerPct:   80,
  pb2SellQtyPct:   40,
};

// ── Colors ────────────────────────────────────────────────────────────────────
const C = {
  bg:"#F5F7FB", surface:"#FFFFFF", surfaceAlt:"#F0F3F9", border:"#E3E8F0",
  text:"#0F172A", textMid:"#475569", textLight:"#94A3B8",
  primary:"#2563EB", primaryLight:"#EFF6FF",
  green:"#059669", greenLight:"#ECFDF5", greenMid:"#D1FAE5",
  red:"#DC2626", redLight:"#FEF2F2", redMid:"#FEE2E2",
  amber:"#D97706", amberLight:"#FFFBEB",
  purple:"#7C3AED", purpleLight:"#F5F3FF",
  teal:"#0891B2", tealLight:"#ECFEFF",
};

const fmt$  = (n) => (n==null||isNaN(n)) ? "—" : "$"+Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtN  = (n,d=2) => (n==null||isNaN(n)) ? "—" : Number(n).toFixed(d);
const fmtPct= (n) => (n==null||isNaN(n)) ? "—" : (n>0?"+":"")+Number(n).toFixed(1)+"%";
const pct   = (a,b) => b ? (a/b)*100 : 0;

// ── Price fetch via Anthropic API (bypasses CORS) ─────────────────────────────
async function fetchPrices(tickers) {
  if (!tickers.length) return {};
  const results = {};
  await Promise.all(tickers.map(async (ticker) => {
    try {
      const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`;
      const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(yahooUrl)}`;
      const r = await fetch(proxyUrl, { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice || meta?.previousClose;
      if (price && price > 0) {
        results[ticker] = {
          price,
          change: (price - (meta?.previousClose || price)),
          changePct: meta?.previousClose ? ((price - meta.previousClose) / meta.previousClose) * 100 : 0,
          high: meta?.regularMarketDayHigh || price,
          low:  meta?.regularMarketDayLow  || price,
        };
      }
    } catch (e) {
      console.warn(`Price fetch failed for ${ticker}:`, e);
    }
  }));
  return results;
}


// totalCapital = live portfolio value + uninvested cash buffer
function calcTotalCapital(stocks, cashBuffer) {
  const invested = stocks.reduce((s,st) => s + (st.totalShares*st.currentPrice||0), 0);
  return invested + (cashBuffer||0);
}

function calcStats(stocks, totalCapital, settings) {
  return stocks.map((st) => {
    const value = (st.totalShares * st.currentPrice) || 0;
    const cost  = (st.totalShares * st.avgCost)      || 0;
    const pl    = value - cost;
    const plPct = cost ? pct(pl, cost) : 0;
    const weight      = pct(value, totalCapital);
    const overweight  = weight > settings.maxPositionPct;
    const underweight = weight > 0 && weight < settings.minPositionPct;
    const pb1Done = (st.profitBookings||[]).some(p=>p.level===1);
    const pb2Done = (st.profitBookings||[]).some(p=>p.level===2);
    let profitAction = null;
    if (st.momentum !== "strong") {
      if (!pb1Done && plPct >= settings.pb1TriggerPct) {
        const sharesToSell = Math.floor(st.totalShares * settings.pb1SellQtyPct/100);
        profitAction = { level:1, label:`Book 40% — Sell ~${sharesToSell} shares`, shares:sharesToSell };
      } else if (pb1Done && !pb2Done && plPct >= settings.pb2TriggerPct) {
        const sharesToSell = Math.floor(st.totalShares * settings.pb2SellQtyPct/100);
        profitAction = { level:2, label:`Book another 40% — Sell ~${sharesToSell} shares`, shares:sharesToSell };
      }
    }
    const bookedPct  = (pb1Done?settings.pb1SellQtyPct:0)+(pb2Done?settings.pb2SellQtyPct:0);
    const rideQtyPct = 100 - bookedPct;
    return { ...st, value, cost, pl, plPct, weight, overweight, underweight, pb1Done, pb2Done, profitAction, rideQtyPct };
  });
}

// ── UI atoms ──────────────────────────────────────────────────────────────────
function Badge({ color, children, small }) {
  const map = {
    green: {bg:C.greenLight,  text:C.green,   border:C.greenMid},
    red:   {bg:C.redLight,    text:C.red,     border:C.redMid},
    amber: {bg:C.amberLight,  text:C.amber,   border:"#FDE68A"},
    blue:  {bg:C.primaryLight,text:C.primary, border:"#BFDBFE"},
    purple:{bg:C.purpleLight, text:C.purple,  border:"#DDD6FE"},
    teal:  {bg:C.tealLight,   text:C.teal,    border:"#A5F3FC"},
    gray:  {bg:C.surfaceAlt,  text:C.textMid, border:C.border},
  };
  const s = map[color]||map.gray;
  return (
    <span style={{display:"inline-flex",alignItems:"center",background:s.bg,color:s.text,
      border:`1px solid ${s.border}`,fontSize:small?9:10,fontWeight:700,
      letterSpacing:"0.05em",padding:small?"1px 5px":"2px 8px",borderRadius:20,whiteSpace:"nowrap"}}>
      {children}
    </span>
  );
}

function Card({children,alert,style={}}) {
  return (
    <div style={{background:C.surface,border:`1.5px solid ${alert?C.red+"55":C.border}`,borderRadius:14,padding:"16px 18px",...style}}>
      {children}
    </div>
  );
}

function SLabel({children}) {
  return <div style={{fontSize:10,fontWeight:700,color:C.textLight,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>{children}</div>;
}

function ABox({type,children}) {
  const map = {
    danger: {bg:C.redLight,  border:"#FCA5A5",text:C.red,  icon:"🚨"},
    warning:{bg:C.amberLight,border:"#FCD34D",text:C.amber,icon:"⚠️"},
    success:{bg:C.greenLight,border:"#6EE7B7",text:C.green,icon:"✓"},
    info:   {bg:C.primaryLight,border:"#93C5FD",text:C.primary,icon:"ℹ"},
    profit: {bg:C.purpleLight,border:"#C4B5FD",text:C.purple,icon:"💰"},
    sip:    {bg:C.tealLight,  border:"#A5F3FC",text:C.teal,  icon:"📥"},
  };
  const s = map[type]||map.info;
  return (
    <div style={{background:s.bg,border:`1px solid ${s.border}`,borderRadius:8,
      padding:"9px 13px",display:"flex",gap:8,alignItems:"flex-start",marginBottom:7}}>
      <span style={{flexShrink:0,fontSize:13}}>{s.icon}</span>
      <span style={{fontSize:12,color:s.text,lineHeight:1.5}}>{children}</span>
    </div>
  );
}

function ProfitStages({st,settings}) {
  const stages = [
    {label:"Entry",                                   pct:0,                     done:true},
    {label:`+${settings.pb1TriggerPct}%\nBook 40%`,  pct:settings.pb1TriggerPct,done:st.pb1Done},
    {label:`+${settings.pb2TriggerPct}%\nBook 40%`,  pct:settings.pb2TriggerPct,done:st.pb2Done},
    {label:"20%\nRides",                              pct:null,                  done:false},
  ];
  return (
    <div style={{display:"flex",gap:0,alignItems:"center",marginTop:8}}>
      {stages.map((s,i)=>(
        <div key={i} style={{display:"flex",alignItems:"center",flex:i<stages.length-1?1:"none"}}>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
            <div style={{width:22,height:22,borderRadius:"50%",
              border:`2px solid ${s.done?C.green:st.plPct>=(s.pct||0)?C.amber:C.border}`,
              background:s.done?C.green:"transparent",
              display:"flex",alignItems:"center",justifyContent:"center",
              fontSize:9,color:s.done?"#fff":C.textLight,fontWeight:700}}>
              {s.done?"✓":i+1}
            </div>
            <div style={{fontSize:8,color:s.done?C.green:C.textLight,textAlign:"center",maxWidth:52,lineHeight:1.2,whiteSpace:"pre-line"}}>{s.label}</div>
          </div>
          {i<stages.length-1 && (
            <div style={{flex:1,height:2,background:s.done?C.green:C.border,margin:"0 3px",marginBottom:18}}/>
          )}
        </div>
      ))}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab,setTab]               = useState("dashboard");
  const [stocks,setStocks]         = useState([]);
  const [settings,setSettings]     = useState(defaultSettings);
  const [loaded,setLoaded]         = useState(false);
  const [toast,setToast]           = useState(null);
  const [editStock,setEditStock]   = useState(null);
  const [showAddForm,setShowAddForm] = useState(false);
  const [editSettings,setEditSettings] = useState(false);
  const [tempSettings,setTempSettings] = useState(defaultSettings);
  const [weeklyLog,setWeeklyLog]   = useState([]);
  const [newLogNote,setNewLogNote] = useState("");
  const [newLogDate,setNewLogDate] = useState(new Date().toISOString().slice(0,10));
  const [sipHistory,setSipHistory] = useState([]);
  const [showSipForm,setShowSipForm] = useState(false);
  const [newSip,setNewSip]         = useState({date:new Date().toISOString().slice(0,10),amount:"",note:""});
  const [newPos,setNewPos]         = useState({ticker:"",totalShares:"",avgCost:"",currentPrice:"",supertrend:"positive",momentum:"high",notes:""});
  const [priceStatus,setPriceStatus] = useState({}); // {ticker: 'loading'|'ok'|'error'}
  const [lastFetched,setLastFetched] = useState(null);

  useEffect(()=>{
    async function load() {
      try {
        const r = await window.storage.get(STORAGE_KEY);
        if (r) {
          const d = JSON.parse(r.value);
          setStocks(d.stocks||defaultPortfolio);
          setSettings(d.settings||defaultSettings);
          setWeeklyLog(d.weeklyLog||[]);
          setSipHistory(d.sipHistory||[]);
        } else { setStocks(defaultPortfolio); }

      } catch { setStocks(defaultPortfolio); }
      setLoaded(true);
    }
    load();
  },[]);

  const persist = useCallback(async(s,st,wl,sh)=>{
    try { await window.storage.set(STORAGE_KEY,JSON.stringify({stocks:s,settings:st,weeklyLog:wl,sipHistory:sh})); showToast("Saved ✓"); }
    catch { showToast("Save failed","error"); }
  },[]);

  const showToast = (msg,type="success")=>{ setToast({msg,type}); setTimeout(()=>setToast(null),2400); };
  const updateStocks = (updated)=>{ setStocks(updated); persist(updated,settings,weeklyLog,sipHistory); };

  async function fetchAllPrices() {
    const tickers = stocks.map(s => s.ticker);
    tickers.forEach(t => setPriceStatus(p => ({...p,[t]:'loading'})));
    const prices = await fetchPrices(tickers);
    if (Object.keys(prices).length === 0) {
      tickers.forEach(t => setPriceStatus(p => ({...p,[t]:'error'})));
      return;
    }
    const updated = stocks.map(s => {
      if (prices[s.ticker]) {
        setPriceStatus(p => ({...p,[s.ticker]:'ok'}));
        return {...s, currentPrice: prices[s.ticker].price};
      }
      setPriceStatus(p => ({...p,[s.ticker]:'error'}));
      return s;
    });
    setStocks(updated);
    setLastFetched(new Date().toLocaleTimeString());
    persist(updated, settings, weeklyLog, sipHistory);
  }


  // ── Live capital = portfolio market value + uninvested cash buffer ──
  const totalCapital  = loaded ? calcTotalCapital(stocks, settings.cashBuffer) : 0;
  const ss            = loaded ? calcStats(stocks, totalCapital, settings) : [];
  const investedValue = ss.reduce((a,s)=>a+s.value,0);
  const totalCost     = ss.reduce((a,s)=>a+s.cost, 0);
  const totalPL       = investedValue - totalCost;
  const totalPLPct    = totalCost ? pct(totalPL,totalCost) : 0;
  const cashValue     = settings.cashBuffer||0;
  const cashPct       = totalCapital>0 ? pct(cashValue,totalCapital) : 0;
  const totalSipAdded = sipHistory.reduce((a,s)=>a+(s.amount||0),0);

  // Max $ per position based on live capital
  const maxPositionValue = (settings.maxPositionPct/100) * totalCapital;
  const minPositionValue = (settings.minPositionPct/100) * totalCapital;
  const targetCashValue  = (settings.cashReservePct/100) * totalCapital;

  const lastSip      = sipHistory.length>0 ? sipHistory[sipHistory.length-1] : null;
  const nextSipDate  = (()=>{
    if (!lastSip) return "Not set";
    const d = new Date(lastSip.date); d.setMonth(d.getMonth()+1);
    return d.toISOString().slice(0,10);
  })();

  const activeStocks = ss.filter(s=>s.supertrend==="positive");
  const sipPerStock  = activeStocks.length>0 && settings.sipAmount>0
    ? settings.sipAmount/activeStocks.length : 0;

  // Alerts
  const alerts = [];
  ss.forEach(st=>{
    if (st.supertrend==="negative") alerts.push({type:"danger", msg:`${st.ticker} — SUPERTREND NEGATIVE. Exit immediately on weekly close.`});
    if (st.profitAction)            alerts.push({type:"profit", msg:`${st.ticker} is ${fmtPct(st.plPct)} — ${st.profitAction.label}`});
    if (st.overweight)              alerts.push({type:"warning",msg:`${st.ticker} overweight at ${fmtN(st.weight)}% (max ${settings.maxPositionPct}%). Trim ~${fmt$(st.value-maxPositionValue)}.`});
  });
  if (cashPct<settings.cashReservePct && investedValue>0)
    alerts.push({type:"warning",msg:`Cash at ${fmtN(cashPct)}% — below ${settings.cashReservePct}% target (${fmt$(targetCashValue)}).`});

  // ── Actions ──
  function addPosition(){
    if (!newPos.ticker) return;
    const s={...newPos,id:Date.now(),totalShares:parseFloat(newPos.totalShares)||0,
      avgCost:parseFloat(newPos.avgCost)||0,currentPrice:parseFloat(newPos.currentPrice)||0,
      addedDate:new Date().toISOString().slice(0,10),profitBookings:[]};
    const updated=[...stocks,s];
    updateStocks(updated);
    setNewPos({ticker:"",totalShares:"",avgCost:"",currentPrice:"",supertrend:"positive",momentum:"high",notes:""});
    setShowAddForm(false);
  }

  function deletePosition(id){
    if (!confirm("Remove this position?")) return;
    updateStocks(stocks.filter(s=>s.id!==id));
    setEditStock(null);
  }

  function saveEdit(){
    const updated=stocks.map(s=>s.id===editStock.id?editStock:s);
    setStocks(updated); persist(updated,settings,weeklyLog,sipHistory);
    setEditStock(null);
  }

  function markExited(id){
    if (!confirm("Mark as exited? Logs the exit.")) return;
    const st=ss.find(s=>s.id===id); if(!st) return;
    const logEntry={id:Date.now(),date:new Date().toISOString().slice(0,10),
      notes:`🚨 EXITED ${st.ticker} — Supertrend negative. P&L: ${fmtPct(st.plPct)} (${fmt$(st.pl)}).`};
    const newLog=[logEntry,...weeklyLog];
    setWeeklyLog(newLog);
    const updated=stocks.filter(s=>s.id!==id);
    setStocks(updated); persist(updated,settings,newLog,sipHistory);
  }

  function recordProfitBooking(st){
    const pb=st.profitAction; if (!pb) return;
    const booking={level:pb.level,date:new Date().toISOString().slice(0,10),sharesSold:pb.shares,priceAtSale:st.currentPrice,gainPct:st.plPct};
    const proceeds=pb.shares*st.currentPrice;
    // proceeds go to cash buffer
    const updatedSettings={...settings,cashBuffer:(settings.cashBuffer||0)+proceeds};
    const updated=stocks.map(s=>s.id===st.id?{...s,totalShares:Math.max(0,s.totalShares-pb.shares),profitBookings:[...(s.profitBookings||[]),booking]}:s);
    const logEntry={id:Date.now(),date:new Date().toISOString().slice(0,10),
      notes:`💰 ${st.ticker} profit booking lv${pb.level}: sold ${pb.shares} shares @ ${fmt$(st.currentPrice)} (${fmtPct(st.plPct)}). +${fmt$(proceeds)} to cash.`};
    const newLog=[logEntry,...weeklyLog];
    setWeeklyLog(newLog); setStocks(updated); setSettings(updatedSettings);
    persist(updated,updatedSettings,newLog,sipHistory);
  }

  function addSip(){
    if (!newSip.amount) return;
    const amount=parseFloat(newSip.amount)||0;
    const entry={id:Date.now(),date:newSip.date,amount,note:newSip.note};
    // SIP increases cash buffer; user will deploy from cash into positions themselves
    const updatedSettings={...settings,cashBuffer:(settings.cashBuffer||0)+amount};
    const newSipHist=[...sipHistory,entry];
    const logEntry={id:Date.now()+1,date:newSip.date,
      notes:`📥 SIP ${fmt$(amount)} added to cash buffer.${newSip.note?" "+newSip.note:""}  New capital: ${fmt$(calcTotalCapital(stocks,updatedSettings.cashBuffer))}.`};
    const newLog=[logEntry,...weeklyLog];
    setSipHistory(newSipHist); setSettings(updatedSettings); setWeeklyLog(newLog);
    persist(stocks,updatedSettings,newLog,newSipHist);
    setNewSip({date:new Date().toISOString().slice(0,10),amount:"",note:""});
    setShowSipForm(false);
  }

  function deleteSip(id){
    const entry=sipHistory.find(s=>s.id===id);
    if (!entry||!confirm("Remove SIP? Cash buffer will decrease.")) return;
    const updatedSettings={...settings,cashBuffer:Math.max(0,(settings.cashBuffer||0)-entry.amount)};
    const newSipHist=sipHistory.filter(s=>s.id!==id);
    setSipHistory(newSipHist); setSettings(updatedSettings);
    persist(stocks,updatedSettings,weeklyLog,newSipHist);
  }

  function addLog(){
    if (!newLogNote) return;
    const entry={id:Date.now(),date:newLogDate,notes:newLogNote};
    const newLog=[entry,...weeklyLog];
    setWeeklyLog(newLog); persist(stocks,settings,newLog,sipHistory);
    setNewLogNote("");
  }

  const TABS=[
    {id:"dashboard",label:"Dashboard"},
    {id:"positions", label:"Positions"},
    {id:"profit",    label:"Profit Plan"},
    {id:"sip",       label:"SIP Capital"},
    {id:"log",       label:"Log"},
    {id:"settings",  label:"Settings"},
  ];
  const PAL=["#2563EB","#7C3AED","#059669","#D97706","#DC2626","#0891B2","#65A30D","#BE185D"];

  if (!loaded) return (
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:"100vh",background:C.bg,fontFamily:"system-ui",color:C.textLight,fontSize:13}}>
      Loading…
    </div>
  );

  return (
    <div style={{minHeight:"100vh",background:C.bg,fontFamily:"-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",color:C.text}}>

      {toast && (
        <div style={{position:"fixed",top:14,right:14,zIndex:999,background:toast.type==="success"?C.green:C.red,
          color:"#fff",padding:"9px 16px",borderRadius:8,fontSize:12,fontWeight:700,boxShadow:"0 4px 16px rgba(0,0,0,0.18)"}}>
          {toast.msg}
        </div>
      )}

      {/* Edit modal */}
      {editStock && (
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.4)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:C.surface,borderRadius:16,padding:22,width:"100%",maxWidth:440,boxShadow:"0 24px 60px rgba(0,0,0,0.2)",maxHeight:"90vh",overflowY:"auto"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:18}}>
              <div style={{fontSize:16,fontWeight:800}}>Edit {editStock.ticker}</div>
              <button onClick={()=>setEditStock(null)} style={{background:"none",border:"none",fontSize:18,cursor:"pointer",color:C.textLight}}>✕</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              {[
                {label:"Total Shares",     key:"totalShares",  type:"number"},
                {label:"Avg Cost ($)",     key:"avgCost",      type:"number"},
                {label:"Current Price ($)",key:"currentPrice", type:"number"},
              ].map(f=>(
                <div key={f.key} style={{gridColumn:f.key==="currentPrice"?"1 / -1":"auto"}}>
                  <div style={{fontSize:10,color:C.textLight,fontWeight:600,marginBottom:4}}>{f.label}</div>
                  <input type={f.type} value={editStock[f.key]} onChange={e=>setEditStock(p=>({...p,[f.key]:parseFloat(e.target.value)||0}))}
                    style={{width:"100%",padding:"8px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:13,fontWeight:600,background:C.bg,boxSizing:"border-box"}}/>
                </div>
              ))}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              <div>
                <div style={{fontSize:10,color:C.textLight,fontWeight:600,marginBottom:4}}>Supertrend</div>
                <select value={editStock.supertrend} onChange={e=>setEditStock(p=>({...p,supertrend:e.target.value}))}
                  style={{width:"100%",padding:"8px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,background:C.bg}}>
                  <option value="positive">▲ Positive</option>
                  <option value="negative">▼ Negative</option>
                </select>
              </div>
              <div>
                <div style={{fontSize:10,color:C.textLight,fontWeight:600,marginBottom:4}}>Momentum</div>
                <select value={editStock.momentum} onChange={e=>setEditStock(p=>({...p,momentum:e.target.value}))}
                  style={{width:"100%",padding:"8px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,background:C.bg}}>
                  <option value="high">High</option>
                  <option value="strong">🔥 Strong</option>
                  <option value="weak">Weak</option>
                </select>
              </div>
            </div>
            <div style={{marginBottom:16}}>
              <div style={{fontSize:10,color:C.textLight,fontWeight:600,marginBottom:4}}>Notes</div>
              <textarea value={editStock.notes} onChange={e=>setEditStock(p=>({...p,notes:e.target.value}))}
                style={{width:"100%",padding:"8px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,background:C.bg,resize:"none",minHeight:56,boxSizing:"border-box"}}/>
            </div>
            <div style={{display:"flex",gap:8}}>
              <button onClick={saveEdit} style={{flex:1,background:C.primary,color:"#fff",border:"none",borderRadius:8,padding:"10px",fontSize:13,fontWeight:700,cursor:"pointer"}}>Save</button>
              <button onClick={()=>deletePosition(editStock.id)} style={{background:C.redLight,color:C.red,border:`1px solid ${C.redMid}`,borderRadius:8,padding:"10px 14px",fontSize:12,fontWeight:700,cursor:"pointer"}}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div style={{background:C.surface,borderBottom:`1px solid ${C.border}`,padding:"0 16px"}}>
        <div style={{maxWidth:860,margin:"0 auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",padding:"16px 0 0"}}>
            <div>
              <div style={{fontSize:17,fontWeight:900,letterSpacing:"-0.04em"}}>MomentumEdge</div>
              <div style={{fontSize:10,color:C.textLight,marginTop:1}}>Weekly Supertrend · Profit Booking · SIP Capital</div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:10,color:C.textLight,marginBottom:2}}>TOTAL CAPITAL (LIVE)</div>
              <div style={{fontSize:21,fontWeight:900,letterSpacing:"-0.03em",color:C.primary}}>{fmt$(totalCapital)}</div>
              <div style={{fontSize:11,fontWeight:700,color:totalPL>=0?C.green:C.red}}>{fmtPct(totalPLPct)} P&L · {fmt$(totalPL)}</div>
            </div>
          </div>
          <div style={{display:"flex",gap:0,marginTop:14,overflowX:"auto"}}>
            {TABS.map(t=>(
              <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"8px 13px",fontSize:12,fontWeight:600,border:"none",cursor:"pointer",
                borderRadius:"6px 6px 0 0",background:tab===t.id?C.bg:"transparent",
                color:tab===t.id?C.primary:C.textMid,
                borderBottom:tab===t.id?`2.5px solid ${C.primary}`:"2.5px solid transparent",whiteSpace:"nowrap"}}>
                {t.label}
                {t.id==="profit"    && ss.filter(s=>s.profitAction).length>0 ? " 🔔":""}
                {t.id==="dashboard" && alerts.filter(a=>a.type==="danger").length>0 ? " 🚨":""}
                {t.id==="sip"       && sipHistory.length>0 ? ` (${sipHistory.length})` :""}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{maxWidth:860,margin:"0 auto",padding:"18px 16px 80px"}}>

        {/* ══ DASHBOARD ══ */}
        {tab==="dashboard" && (
          <div>
            {/* Live price bar */}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"10px 14px",marginBottom:14}}>
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <span style={{fontSize:11,fontWeight:700,color:C.textMid}}>Live Prices</span>
                {lastFetched && <span style={{fontSize:10,color:C.textLight}}>Updated {lastFetched}</span>}
                <span style={{fontSize:10,color:C.textLight}}>Yahoo Finance · no key needed</span>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {stocks.map(s=>(
                    <span key={s.ticker} style={{fontSize:10,fontWeight:700,
                      color: priceStatus[s.ticker]==="ok" ? C.green : priceStatus[s.ticker]==="loading" ? C.amber : priceStatus[s.ticker]==="error" ? C.red : C.textLight}}>
                      {s.ticker} {priceStatus[s.ticker]==="loading" ? "⟳" : priceStatus[s.ticker]==="ok" ? "✓" : priceStatus[s.ticker]==="error" ? "✕" : "·"}
                    </span>
                  ))}
                </div>
              </div>
              <div style={{display:"flex",gap:7}}>
                <button onClick={fetchAllPrices} style={{background:C.primary,color:"#fff",border:"none",borderRadius:7,padding:"5px 14px",fontSize:11,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:5}}>
                  ↻ Refresh Prices
                </button>
              </div>
            </div>
            {/* Capital breakdown */}
            <Card style={{marginBottom:16,background:"linear-gradient(135deg,#EFF6FF 0%,#F5F3FF 100%)",border:`1.5px solid #BFDBFE`}}>
              <SLabel>Live Capital Breakdown</SLabel>
              <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                {[
                  {label:"Invested (stocks)",  value:fmt$(investedValue), sub:fmtN(pct(investedValue,totalCapital))+"% of capital", color:C.primary},
                  {label:"Cash Buffer",        value:fmt$(cashValue),     sub:fmtN(cashPct)+"% of capital",                        color:cashPct>=settings.cashReservePct?C.green:C.amber},
                  {label:"Total Capital",      value:fmt$(totalCapital),  sub:"Stocks + Cash = Capital",                            color:C.purple, big:true},
                  {label:"Total P&L",          value:fmtPct(totalPLPct), sub:fmt$(totalPL),                                        color:totalPL>=0?C.green:C.red},
                ].map(s=>(
                  <div key={s.label} style={{background:"rgba(255,255,255,0.7)",borderRadius:10,padding:"12px 14px",flex:`1 1 ${s.big?"160px":"110px"}`}}>
                    <div style={{fontSize:9,color:C.textLight,fontWeight:700,letterSpacing:"0.12em",marginBottom:4,textTransform:"uppercase"}}>{s.label}</div>
                    <div style={{fontSize:s.big?22:18,fontWeight:900,color:s.color,lineHeight:1}}>{s.value}</div>
                    <div style={{fontSize:10,color:C.textMid,marginTop:3}}>{s.sub}</div>
                  </div>
                ))}
              </div>
              <div style={{marginTop:12,fontSize:11,color:C.primary,background:"rgba(255,255,255,0.6)",borderRadius:7,padding:"7px 10px"}}>
                ℹ Total Capital updates automatically as your stock prices change. Update current prices weekly to keep it accurate.
              </div>
            </Card>

            {/* Alerts */}
            {alerts.length>0 && (
              <div style={{marginBottom:16}}>
                <SLabel>Action Required</SLabel>
                {alerts.map((a,i)=><ABox key={i} type={a.type}>{a.msg}</ABox>)}
              </div>
            )}
            {alerts.length===0 && <ABox type="success">All clear — no action needed this week.</ABox>}

            {/* Weight bar */}
            <Card style={{marginBottom:16}}>
              <SLabel>Portfolio Weight (of {fmt$(totalCapital)} capital)</SLabel>
              <div style={{display:"flex",height:26,borderRadius:6,overflow:"hidden",marginBottom:12}}>
                {ss.filter(s=>s.weight>0).map((st,i)=>(
                  <div key={st.id} title={`${st.ticker} ${fmtN(st.weight)}%`}
                    style={{width:`${st.weight}%`,background:PAL[i%PAL.length],display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"#fff",fontWeight:700,overflow:"hidden",minWidth:2}}>
                    {st.weight>6?st.ticker:""}
                  </div>
                ))}
                {cashPct>0 && (
                  <div style={{width:`${Math.min(cashPct,100)}%`,background:"#E2E8F0",display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:C.textLight,fontWeight:600,minWidth:4}}>
                    {cashPct>5?"CASH":""}
                  </div>
                )}
              </div>
              <div style={{display:"flex",flexWrap:"wrap",gap:8}}>
                {ss.map((st,i)=>(
                  <div key={st.id} style={{display:"flex",alignItems:"center",gap:5,fontSize:11}}>
                    <div style={{width:9,height:9,borderRadius:2,background:PAL[i%PAL.length]}}/>
                    <span style={{fontWeight:700}}>{st.ticker}</span>
                    <span style={{color:st.overweight?C.red:st.underweight?C.amber:C.textMid}}>{fmtN(st.weight)}%</span>
                    <span style={{color:C.textLight,fontSize:10}}>{fmt$(st.value)}</span>
                    {st.supertrend==="negative" && <Badge color="red" small>EXIT</Badge>}
                    {st.momentum==="strong"     && <Badge color="teal" small>🔥</Badge>}
                  </div>
                ))}
                {cashPct>0 && (
                  <div style={{display:"flex",alignItems:"center",gap:5,fontSize:11}}>
                    <div style={{width:9,height:9,borderRadius:2,background:"#E2E8F0"}}/>
                    <span style={{fontWeight:700,color:C.textMid}}>CASH</span>
                    <span style={{color:C.textMid}}>{fmtN(cashPct)}% · {fmt$(cashValue)}</span>
                  </div>
                )}
              </div>
            </Card>

            {/* Table */}
            <Card>
              <SLabel>Holdings</SLabel>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{background:C.surfaceAlt}}>
                      {["Ticker","Shares","Price","Value","% of Capital","P&L","Trend","Momentum"].map(h=>(
                        <th key={h} style={{padding:"7px 11px",textAlign:"left",fontSize:9,fontWeight:700,color:C.textLight,letterSpacing:"0.1em",whiteSpace:"nowrap"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ss.map(st=>(
                      <tr key={st.id} style={{borderTop:`1px solid ${C.border}`,background:st.supertrend==="negative"?C.redLight:"transparent"}}>
                        <td style={{padding:"9px 11px",fontWeight:800,fontSize:13}}>{st.ticker}</td>
                        <td style={{padding:"9px 11px",fontSize:12}}>{fmtN(st.totalShares,2)}</td>
                        <td style={{padding:"9px 11px",fontSize:12}}>{fmt$(st.currentPrice)}</td>
                        <td style={{padding:"9px 11px",fontSize:12,fontWeight:600}}>{fmt$(st.value)}</td>
                        <td style={{padding:"9px 11px",fontSize:12,fontWeight:700,color:st.overweight?C.red:st.underweight?C.amber:C.text}}>
                          {fmtN(st.weight)}%
                          <span style={{fontSize:9,color:C.textLight,marginLeft:4}}>max {settings.maxPositionPct}%</span>
                        </td>
                        <td style={{padding:"9px 11px",fontSize:12,fontWeight:700,color:st.pl>=0?C.green:C.red}}>{fmtPct(st.plPct)}</td>
                        <td style={{padding:"9px 11px"}}><Badge color={st.supertrend==="positive"?"green":"red"}>{st.supertrend==="positive"?"▲":"▼ EXIT"}</Badge></td>
                        <td style={{padding:"9px 11px"}}>
                          {st.momentum==="strong"&&<Badge color="teal">🔥 Strong</Badge>}
                          {st.momentum==="high"  &&<Badge color="blue">High</Badge>}
                          {st.momentum==="weak"  &&<Badge color="amber">Weak</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        )}

        {/* ══ POSITIONS ══ */}
        {tab==="positions" && (
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontSize:14,fontWeight:800}}>Positions</div>
              <div style={{display:"flex",gap:7}}>
                <button onClick={fetchAllPrices} style={{background:C.surfaceAlt,color:C.textMid,border:`1px solid ${C.border}`,borderRadius:8,padding:"7px 12px",fontSize:11,fontWeight:700,cursor:"pointer"}}>↻ Refresh</button>
                <button onClick={()=>setShowAddForm(!showAddForm)} style={{background:C.primary,color:"#fff",border:"none",borderRadius:8,padding:"8px 16px",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                  {showAddForm?"✕ Cancel":"+ Add Position"}
                </button>
              </div>
            </div>

            {showAddForm && (
              <Card style={{marginBottom:16,border:`1.5px solid ${C.primary}55`}}>
                <SLabel>New Position</SLabel>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:10,marginBottom:12}}>
                  {[
                    {label:"Ticker",     key:"ticker",      type:"text",   ph:"e.g. NVDA"},
                    {label:"Shares",     key:"totalShares", type:"number", ph:"0"},
                    {label:"Avg Cost",   key:"avgCost",     type:"number", ph:"0.00"},
                    {label:"Curr Price", key:"currentPrice",type:"number", ph:"0.00"},
                  ].map(f=>(
                    <div key={f.key}>
                      <div style={{fontSize:10,color:C.textLight,fontWeight:600,marginBottom:4}}>{f.label}</div>
                      <input type={f.type} placeholder={f.ph} value={newPos[f.key]} onChange={e=>setNewPos(p=>({...p,[f.key]:e.target.value}))}
                        style={{width:"100%",padding:"7px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,background:C.bg,boxSizing:"border-box"}}/>
                    </div>
                  ))}
                  <div>
                    <div style={{fontSize:10,color:C.textLight,fontWeight:600,marginBottom:4}}>Supertrend</div>
                    <select value={newPos.supertrend} onChange={e=>setNewPos(p=>({...p,supertrend:e.target.value}))}
                      style={{width:"100%",padding:"7px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,background:C.bg}}>
                      <option value="positive">▲ Positive</option>
                      <option value="negative">▼ Negative</option>
                    </select>
                  </div>
                  <div>
                    <div style={{fontSize:10,color:C.textLight,fontWeight:600,marginBottom:4}}>Momentum</div>
                    <select value={newPos.momentum} onChange={e=>setNewPos(p=>({...p,momentum:e.target.value}))}
                      style={{width:"100%",padding:"7px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,background:C.bg}}>
                      <option value="high">High</option>
                      <option value="strong">🔥 Strong</option>
                      <option value="weak">Weak</option>
                    </select>
                  </div>
                </div>
                <div style={{marginBottom:12}}>
                  <div style={{fontSize:10,color:C.textLight,fontWeight:600,marginBottom:4}}>Notes</div>
                  <textarea placeholder="Entry reason, catalyst…" value={newPos.notes} onChange={e=>setNewPos(p=>({...p,notes:e.target.value}))}
                    style={{width:"100%",padding:"7px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,background:C.bg,resize:"none",minHeight:48,boxSizing:"border-box"}}/>
                </div>
                <button onClick={addPosition} style={{background:C.primary,color:"#fff",border:"none",borderRadius:8,padding:"9px 20px",fontSize:12,fontWeight:700,cursor:"pointer"}}>Save Position</button>
              </Card>
            )}

            <div style={{display:"flex",flexDirection:"column",gap:10}}>
              {ss.map(st=>(
                <Card key={st.id} alert={st.supertrend==="negative"}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
                    <div>
                      <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:3,flexWrap:"wrap"}}>
                        <span style={{fontSize:16,fontWeight:900}}>{st.ticker}</span>
                        <Badge color={st.supertrend==="positive"?"green":"red"}>{st.supertrend==="positive"?"▲ HOLD":"▼ EXIT NOW"}</Badge>
                        {st.momentum==="strong"&&<Badge color="teal">🔥 Strong</Badge>}
                        {st.momentum==="weak"  &&<Badge color="amber">Weak</Badge>}
                        {st.overweight         &&<Badge color="red">Overweight</Badge>}
                      </div>
                      <div style={{fontSize:10,color:C.textLight}}>Added {st.addedDate} · {fmtN(st.totalShares,4)} shares</div>
                    </div>
                    <div style={{display:"flex",gap:6}}>
                      <button onClick={()=>setEditStock({...st})} style={{background:C.surfaceAlt,color:C.textMid,border:`1px solid ${C.border}`,borderRadius:7,padding:"5px 10px",fontSize:11,fontWeight:600,cursor:"pointer"}}>Edit</button>
                      {st.supertrend==="negative" && (
                        <button onClick={()=>markExited(st.id)} style={{background:C.red,color:"#fff",border:"none",borderRadius:7,padding:"5px 10px",fontSize:11,fontWeight:700,cursor:"pointer"}}>Exit ✕</button>
                      )}
                    </div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(100px,1fr))",gap:7,marginBottom:8}}>
                    {[
                      {label:"Avg Cost",   val:fmt$(st.avgCost)},
                      {label:"Current",    val:fmt$(st.currentPrice)},
                      {label:"Value",      val:fmt$(st.value)},
                      {label:"P&L",        val:fmtPct(st.plPct),    color:st.pl>=0?C.green:C.red},
                      {label:"% Capital",  val:fmtN(st.weight)+"%", color:st.overweight?C.red:C.text},
                      {label:"Ride Left",  val:fmtN(st.rideQtyPct)+"%",color:C.purple},
                    ].map(f=>(
                      <div key={f.label} style={{background:C.surfaceAlt,borderRadius:7,padding:"7px 9px"}}>
                        <div style={{fontSize:9,color:C.textLight,fontWeight:700,marginBottom:2}}>{f.label}</div>
                        <div style={{fontSize:13,fontWeight:800,color:f.color||C.text}}>{f.val}</div>
                      </div>
                    ))}
                  </div>
                  {st.notes&&<div style={{fontSize:11,color:C.textMid,background:C.surfaceAlt,borderRadius:7,padding:"6px 9px"}}>📝 {st.notes}</div>}
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* ══ PROFIT PLAN ══ */}
        {tab==="profit" && (
          <div>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>Profit Booking Plan</div>
            <div style={{fontSize:12,color:C.textMid,marginBottom:16}}>
              Book 40% at +{settings.pb1TriggerPct}% → Book 40% at +{settings.pb2TriggerPct}% → Last 20% rides until Supertrend exits. Proceeds go to cash buffer. 🔥 Strong = ride full.
            </div>
            {ss.filter(s=>s.profitAction).map(st=>(
              <ABox key={st.id} type="profit">
                <strong>{st.ticker}</strong> is {fmtPct(st.plPct)} — {st.profitAction.label}
                <button onClick={()=>recordProfitBooking(st)}
                  style={{marginLeft:12,background:C.purple,color:"#fff",border:"none",borderRadius:6,padding:"3px 10px",fontSize:11,fontWeight:700,cursor:"pointer"}}>
                  Book Now
                </button>
              </ABox>
            ))}
            <div style={{display:"flex",flexDirection:"column",gap:12,marginTop:8}}>
              {ss.map(st=>(
                <Card key={st.id}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontSize:15,fontWeight:900}}>{st.ticker}</span>
                      <span style={{fontSize:13,fontWeight:700,color:st.pl>=0?C.green:C.red}}>{fmtPct(st.plPct)}</span>
                      {st.momentum==="strong"&&<Badge color="teal">🔥 Riding full</Badge>}
                    </div>
                    <div style={{fontSize:11,color:C.textMid}}>{fmtN(st.rideQtyPct)}% held</div>
                  </div>
                  <ProfitStages st={st} settings={settings}/>
                  {(st.profitBookings||[]).length>0 && (
                    <div style={{marginTop:12}}>
                      <div style={{fontSize:9,color:C.textLight,fontWeight:700,letterSpacing:"0.1em",marginBottom:6}}>BOOKING HISTORY</div>
                      {st.profitBookings.map((b,i)=>(
                        <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:11,color:C.textMid,padding:"4px 0",borderTop:`1px solid ${C.border}`}}>
                          <span>Level {b.level} — {b.date}</span>
                          <span style={{fontWeight:700,color:C.green}}>Sold {b.sharesSold} @ {fmt$(b.priceAtSale)} ({fmtPct(b.gainPct)})</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {st.momentum==="strong" && (
                    <div style={{marginTop:10,background:C.tealLight,border:`1px solid #A5F3FC`,borderRadius:7,padding:"7px 10px",fontSize:11,color:C.teal}}>
                      🔥 Strong momentum — holding full position until Supertrend flips negative.
                    </div>
                  )}
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* ══ SIP CAPITAL ══ */}
        {tab==="sip" && (
          <div>
            <div style={{fontSize:14,fontWeight:800,marginBottom:4}}>SIP — Capital Pool</div>
            <div style={{fontSize:12,color:C.textMid,marginBottom:16}}>
              Each SIP adds to your <strong>cash buffer</strong>, which increases your total capital automatically. Then deploy from cash into active positions.
            </div>

            <div style={{display:"flex",gap:10,flexWrap:"wrap",marginBottom:16}}>
              {[
                {label:"Total Capital (live)", value:fmt$(totalCapital),   color:C.primary},
                {label:"Cash Buffer",          value:fmt$(cashValue),      color:cashPct>=settings.cashReservePct?C.green:C.amber},
                {label:"Total SIP Added",      value:fmt$(totalSipAdded),  color:C.purple},
                {label:"Next SIP Due",         value:nextSipDate,          color:C.teal},
              ].map(s=>(
                <div key={s.label} style={{background:C.surface,border:`1.5px solid ${C.border}`,borderRadius:12,padding:"14px 16px",flex:"1 1 110px"}}>
                  <div style={{fontSize:9,color:C.textLight,fontWeight:700,letterSpacing:"0.12em",marginBottom:5,textTransform:"uppercase"}}>{s.label}</div>
                  <div style={{fontSize:16,fontWeight:900,color:s.color}}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Deployment guide */}
            <Card style={{marginBottom:16,border:`1.5px solid ${C.teal}44`}}>
              <SLabel>Deploy Next SIP ({fmt$(settings.sipAmount)}) — Split Across Active Stocks</SLabel>
              <div style={{fontSize:12,color:C.textMid,marginBottom:12}}>
                {activeStocks.length} active positions · {fmt$(sipPerStock)} each
              </div>
              {activeStocks.length>0 ? (
                <div style={{display:"flex",flexDirection:"column",gap:7}}>
                  {activeStocks.map((st,i)=>(
                    <div key={st.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                      background:C.surfaceAlt,borderRadius:8,padding:"10px 14px"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <div style={{width:8,height:8,borderRadius:"50%",background:PAL[i%PAL.length]}}/>
                        <span style={{fontWeight:700,fontSize:13}}>{st.ticker}</span>
                        <Badge color={st.momentum==="strong"?"teal":"blue"}>{st.momentum==="strong"?"🔥 Strong":"High"}</Badge>
                        <span style={{fontSize:11,color:C.textMid}}>{fmtN(st.weight)}% of capital</span>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:14,fontWeight:800,color:C.teal}}>{fmt$(sipPerStock)}</div>
                        <div style={{fontSize:10,color:C.textLight}}>
                          ≈ {st.currentPrice>0?fmtN(sipPerStock/st.currentPrice,3):"—"} shares @ {fmt$(st.currentPrice)}
                        </div>
                      </div>
                    </div>
                  ))}
                  <div style={{padding:"8px 12px",background:C.primaryLight,borderRadius:7,fontSize:11,color:C.primary,marginTop:4}}>
                    ℹ Add extra weight to 🔥 Strong momentum stocks if you want to overweight your best performers.
                  </div>
                </div>
              ) : (
                <div style={{fontSize:12,color:C.textLight,textAlign:"center",padding:"16px 0"}}>No active Supertrend-positive positions.</div>
              )}
            </Card>

            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:13,fontWeight:700}}>SIP History</div>
              <button onClick={()=>setShowSipForm(!showSipForm)} style={{background:C.purple,color:"#fff",border:"none",borderRadius:8,padding:"7px 14px",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                {showSipForm?"✕ Cancel":"+ Record SIP"}
              </button>
            </div>

            {showSipForm && (
              <Card style={{marginBottom:14,border:`1.5px solid ${C.purple}44`}}>
                <SLabel>Record SIP Deposit</SLabel>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
                  <div>
                    <div style={{fontSize:10,color:C.textLight,fontWeight:600,marginBottom:4}}>Date</div>
                    <input type="date" value={newSip.date} onChange={e=>setNewSip(p=>({...p,date:e.target.value}))}
                      style={{width:"100%",padding:"8px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,background:C.bg,boxSizing:"border-box"}}/>
                  </div>
                  <div>
                    <div style={{fontSize:10,color:C.textLight,fontWeight:600,marginBottom:4}}>Amount ($)</div>
                    <input type="number" placeholder={String(settings.sipAmount)} value={newSip.amount} onChange={e=>setNewSip(p=>({...p,amount:e.target.value}))}
                      style={{width:"100%",padding:"8px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:13,fontWeight:700,background:C.bg,boxSizing:"border-box"}}/>
                  </div>
                </div>
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:10,color:C.textLight,fontWeight:600,marginBottom:4}}>Note (optional)</div>
                  <input type="text" placeholder="e.g. Monthly Jan" value={newSip.note} onChange={e=>setNewSip(p=>({...p,note:e.target.value}))}
                    style={{width:"100%",padding:"8px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,background:C.bg,boxSizing:"border-box"}}/>
                </div>
                {newSip.amount && (
                  <div style={{background:C.tealLight,border:`1px solid #A5F3FC`,borderRadius:7,padding:"8px 12px",marginBottom:10,fontSize:12,color:C.teal}}>
                    Cash buffer: {fmt$(cashValue)} → <strong>{fmt$(cashValue+(parseFloat(newSip.amount)||0))}</strong>
                    &nbsp;·&nbsp; New total capital: <strong>{fmt$(totalCapital+(parseFloat(newSip.amount)||0))}</strong>
                  </div>
                )}
                <button onClick={addSip} style={{background:C.purple,color:"#fff",border:"none",borderRadius:8,padding:"9px 20px",fontSize:12,fontWeight:700,cursor:"pointer"}}>
                  Add to Capital
                </button>
              </Card>
            )}

            {sipHistory.length===0 && (
              <div style={{textAlign:"center",padding:"30px 0",color:C.textLight,fontSize:13}}>No SIP entries yet.</div>
            )}
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {[...sipHistory].reverse().map(entry=>(
                <div key={entry.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:10,padding:"12px 16px",
                  display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontSize:14,fontWeight:800,color:C.purple}}>{fmt$(entry.amount)}</div>
                    <div style={{fontSize:11,color:C.textLight,marginTop:2}}>{entry.date}{entry.note?" · "+entry.note:""}</div>
                  </div>
                  <button onClick={()=>deleteSip(entry.id)} style={{background:"none",border:"none",color:C.textLight,cursor:"pointer",fontSize:13}}>✕</button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══ LOG ══ */}
        {tab==="log" && (
          <div>
            <div style={{fontSize:14,fontWeight:800,marginBottom:16}}>Weekly Review Log</div>
            <Card style={{marginBottom:16,border:`1.5px solid ${C.primary}44`}}>
              <SLabel>New Entry</SLabel>
              <input type="date" value={newLogDate} onChange={e=>setNewLogDate(e.target.value)}
                style={{width:"100%",padding:"7px 10px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,background:C.bg,marginBottom:10,boxSizing:"border-box"}}/>
              <textarea placeholder="e.g. MRVL strong — riding. SIP $500 deployed. CRDO watch next close…"
                value={newLogNote} onChange={e=>setNewLogNote(e.target.value)}
                style={{width:"100%",padding:"9px 12px",border:`1px solid ${C.border}`,borderRadius:7,fontSize:12,background:C.bg,resize:"none",minHeight:80,boxSizing:"border-box",marginBottom:10}}/>
              <button onClick={addLog} style={{background:C.primary,color:"#fff",border:"none",borderRadius:8,padding:"8px 20px",fontSize:12,fontWeight:700,cursor:"pointer"}}>Save Entry</button>
            </Card>
            {weeklyLog.length===0&&<div style={{textAlign:"center",padding:"40px 0",color:C.textLight,fontSize:13}}>No entries yet.</div>}
            <div style={{display:"flex",flexDirection:"column",gap:9}}>
              {weeklyLog.map(e=>(
                <div key={e.id} style={{background:C.surface,border:`1px solid ${C.border}`,borderRadius:11,padding:"13px 16px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
                    <span style={{fontSize:11,fontWeight:700,color:C.primary}}>{e.date}</span>
                    <button onClick={()=>{const n=weeklyLog.filter(l=>l.id!==e.id);setWeeklyLog(n);persist(stocks,settings,n,sipHistory);}}
                      style={{background:"none",border:"none",color:C.textLight,cursor:"pointer",fontSize:12}}>✕</button>
                  </div>
                  <div style={{fontSize:12,color:C.textMid,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{e.notes}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══ SETTINGS ══ */}
        {tab==="settings" && (
          <div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:14,fontWeight:800}}>Settings</div>
              {!editSettings
                ? <button onClick={()=>{setTempSettings(settings);setEditSettings(true);}} style={{background:C.primary,color:"#fff",border:"none",borderRadius:8,padding:"8px 16px",fontSize:12,fontWeight:700,cursor:"pointer"}}>Edit</button>
                : <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>{setSettings(tempSettings);persist(stocks,tempSettings,weeklyLog,sipHistory);setEditSettings(false);}} style={{background:C.green,color:"#fff",border:"none",borderRadius:8,padding:"8px 16px",fontSize:12,fontWeight:700,cursor:"pointer"}}>Save</button>
                    <button onClick={()=>setEditSettings(false)} style={{background:C.surfaceAlt,color:C.textMid,border:`1px solid ${C.border}`,borderRadius:8,padding:"8px 16px",fontSize:12,cursor:"pointer"}}>Cancel</button>
                  </div>
              }
            </div>

            {/* Live capital summary */}
            <Card style={{marginBottom:14,background:"linear-gradient(135deg,#EFF6FF,#F5F3FF)",border:`1.5px solid #BFDBFE`}}>
              <SLabel>Live Capital (auto-calculated)</SLabel>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
                {[
                  {label:"Invested (stocks)", value:fmt$(investedValue)},
                  {label:"Cash Buffer",       value:fmt$(cashValue)},
                  {label:"Total Capital",     value:fmt$(totalCapital), bold:true},
                ].map(s=>(
                  <div key={s.label} style={{background:"rgba(255,255,255,0.7)",borderRadius:8,padding:"10px 12px"}}>
                    <div style={{fontSize:9,color:C.textLight,fontWeight:700,letterSpacing:"0.1em",marginBottom:3,textTransform:"uppercase"}}>{s.label}</div>
                    <div style={{fontSize:s.bold?18:15,fontWeight:900,color:s.bold?C.primary:C.text}}>{s.value}</div>
                  </div>
                ))}
              </div>
              <div style={{marginTop:10,fontSize:11,color:C.primary}}>
                Total Capital = stock values + cash buffer. Updates live when prices change.
              </div>
            </Card>

            <Card>
              {[
                {label:"Cash Buffer ($)",          key:"cashBuffer",     desc:"Uninvested cash outside positions. Update when you deploy or receive money.",prefix:"$"},
                {label:"Monthly SIP Amount ($)",   key:"sipAmount",      desc:"Default monthly deposit amount",                                             prefix:"$"},
                {label:"Max Position (%)",         key:"maxPositionPct", desc:"Max % of total capital in any one stock",                                    prefix:"%"},
                {label:"Min Position (%)",         key:"minPositionPct", desc:"Positions below this are too small",                                         prefix:"%"},
                {label:"Cash Reserve (%)",         key:"cashReservePct", desc:"Target minimum cash as % of total capital",                                  prefix:"%"},
                {label:"Max Positions",            key:"maxPositions",   desc:"5–7 ideal for under $10k",                                                   prefix:"#"},
                {label:"1st Profit Trigger (%)",   key:"pb1TriggerPct",  desc:"Book 40% of shares at this % gain",                                          prefix:"%"},
                {label:"1st Book Qty (%)",         key:"pb1SellQtyPct",  desc:"% of shares to sell at trigger 1",                                           prefix:"%"},
                {label:"2nd Profit Trigger (%)",   key:"pb2TriggerPct",  desc:"Book 40% again at this % gain",                                              prefix:"%"},
                {label:"2nd Book Qty (%)",         key:"pb2SellQtyPct",  desc:"% of shares to sell at trigger 2",                                           prefix:"%"},
              ].map((f,i,arr)=>(
                <div key={f.key} style={{padding:"14px 16px",borderBottom:i<arr.length-1?`1px solid ${C.border}`:"none",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div>
                    <div style={{fontSize:13,fontWeight:600,marginBottom:1}}>{f.label}</div>
                    <div style={{fontSize:11,color:C.textLight}}>{f.desc}</div>
                    {/* Show derived $ value for % settings */}
                    {f.prefix==="%"&&!editSettings&&(
                      <div style={{fontSize:10,color:C.primary,marginTop:2}}>
                        = {fmt$((settings[f.key]/100)*totalCapital)} of {fmt$(totalCapital)} capital
                      </div>
                    )}
                  </div>
                  {editSettings
                    ? <input type="number" value={tempSettings[f.key]} onChange={e=>setTempSettings(p=>({...p,[f.key]:parseFloat(e.target.value)||0}))}
                        style={{width:90,padding:"7px 10px",border:`1.5px solid ${C.primary}`,borderRadius:7,fontSize:13,fontWeight:700,textAlign:"right",background:C.bg}}/>
                    : <div style={{fontSize:16,fontWeight:900,color:C.primary}}>
                        {f.prefix==="$"?fmt$(settings[f.key]):settings[f.key]+(f.prefix==="%"?"%":"")}
                      </div>
                  }
                </div>
              ))}
            </Card>
                        <div style={{marginTop:14,background:C.amberLight,border:`1px solid #FDE68A`,borderRadius:10,padding:"11px 14px",fontSize:12,color:C.amber,lineHeight:1.6}}>
              <strong>How capital works:</strong> Total Capital = all stock values + cash buffer. Update stock prices weekly and update Cash Buffer whenever you deploy SIP money into stocks or receive proceeds from profit booking.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
