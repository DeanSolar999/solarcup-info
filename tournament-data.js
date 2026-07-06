/* ============================================================
   SOLAR CUP TWO · 共用資料層 tournament-data.js
   qualifying.html 與 bracket-tree.html 共用同一份賽事資料
   一次生成：報名 → 初賽 25 組 → 失分率分流 → 四階級
   ============================================================ */
(function(global){
  'use strict';

  // ---- 球團資料（十團 + 自由為中性灰）----
  const CLUB_DATA=[
    {key:'huanle',name:'歡樂',full:'歡樂羽球隊',c:'#ff8a3c'},{key:'yuzhou',name:'小羽宙',full:'小羽宙',c:'#22d3ee'},
    {key:'poli',name:'魄力',full:'魄力羽球',c:'#ff3ca6'},{key:'dachuan',name:'大船',full:'大船羽球',c:'#6b6bff'},
    {key:'limao',name:'狸貓拳',full:'狸貓拳羽球隊',c:'#2ee6c8'},{key:'dangdang',name:'蕩蕩',full:'蕩蕩歡樂羽球團',c:'#a3e635'},
    {key:'yuguang',name:'羽光',full:'羽光羽球團',c:'#a855f7'},{key:'solarA',name:'曜日一',full:'曜日一',c:'#ffb3d1'},
    {key:'solarB',name:'曜日二',full:'曜日二',c:'#ff9ec4'},{key:'free',name:'自由',full:'自由組',c:'#8a95a5'},
  ];
  const CLUB_BY_KEY={};CLUB_DATA.forEach(c=>CLUB_BY_KEY[c.key]=c);
  // 九球團（有隊伍歸屬）+ 自由（不計團體積分）
  const NINE=CLUB_DATA.filter(c=>c.key!=='free');
  const FREE=CLUB_BY_KEY['free'];

  const TIER_META={
    plat:{name:'白金',en:'PLATINUM',col:'#4d9fff',base:300,lane:'comp'},
    gold:{name:'黃金',en:'GOLD',col:'#ffcf33',base:200,lane:'comp'},
    silver:{name:'白銀',en:'SILVER',col:'#ff4d6a',base:100,lane:'casual'},
    bronze:{name:'青銅',en:'BRONZE',col:'#34e07a',base:0,lane:'casual'},
  };

  // ---- 真實隊伍名單（曜日盃TWO_賽事整合主檔；僅隊名/球團/選手暱稱，手機Email不入站）----
  // 每團 comp 4 隊 + casual 6 隊；曜請 8 隊獨立。格式 [隊名, 選手一, 選手二]
  const ROSTER={
    huanle:{comp:[['喵喵喵喵喵','湯包','阿達'],['目前沒想法','小P','亮亮'],['阿嬤特拉斯','勝利','小村'],['我不想比賽','小溫','Steven']],
      casual:[['放過老人家','丹尼','東于'],['打那個胖子','達比','阿林'],['伊森吃～恩','包恩','Ethan'],['飛長丸美','丸弟','小飛'],['可攻也可守','小柯','大雄'],['自由自在瘋','Ben','阿風']]},
    yuzhou:{comp:[['琳達雙余座','Carry','尾巴'],['淇淇與弟弟','淇淇','柴克'],['羽你亂鬥','肥力','哈倫'],['我們想一下','Kai','黑輪']],
      casual:[['野雞出來浪','俊介','Ian'],['謙BU可擋','咘咘','謙謙'],['吃屎吉娃娃','小B','YaYa'],['蔥爆吉娃娃','Ryan QoQ','James VoV'],['明年40了','達達','阿杰'],['媽呀傑奶大','James','W']]},
    poli:{comp:[['魄力代表隊','亞馬','Frank'],['大調查小學','阿嚕','小狐狸'],['Skip','Jack','小阿明'],['還在磨合中','Bernie','小豪']],
      casual:[['荖蒻慚冰','Kent','村長'],['揪蛋幾勒','阿比','阿力'],['電力十足','小志','皮卡丘'],['歐恩吸壹 ONCE','Neil','Joe'],['兩隻噗嚨共','武','龍'],['芬散注意力','阿芬','威力']]},
    dachuan:{comp:[['鴛鴛相報','阿浩','Rick'],['TD','阿鈦','莫迪'],['來TGB打','大熊','誠誠'],['就來試試','亞哲','駿']],
      casual:[['支援TGB','挨滴','子銘'],['Ho力薛','薛寶','瓦力'],['發起就掛網','Nice','俊恩'],['摸蜆仔兼seiko','Jeff','YY'],['樺騏來','阿樺','騏騏'],['請假來比賽','夯特','小澤']]},
    limao:{comp:[['狸貓金Carry','牛牛','Kerry'],['萊一群狸貓','萊姆','阿群'],['太子變狸貓','Darren','喬治'],['勿《惹》 Me','Zin','烏克']],
      casual:[['出事了阿北','宸宸','阿和'],['啊對對對隊','小海','Howard'],['狸貓愛波霸','Eddie','Mango'],['禮貌的狸貓','柴犬','阿堯'],['耍廢的狸貓','Hank','Tim'],['GOGO齊狸王','尼克','KC']]},
    dangdang:{comp:[['干飯二人組','Nick','建宏'],['早餐暈碳','玉米','饅頭'],['恐龍扛狼扛','樹樹','克里斯'],['翔翔醬','大翔','小余']],
      casual:[['古咕古','小古','小林'],['JoeJoe雨林','宇霖','Joe'],['柚呆又菜','柚子','皓呆'],['線條洨狗','普爾','Hank'],['OOHH','歐文','Hugo'],['馬Leo','Leo翔','馬力歐']]},
    yuguang:{comp:[['V.SOP來一杯','Vernon','Steven'],['裕擎故縱','裕智','擎元'],['早安宸柏','Shawn','Polur'],['Han悠','小悠','Hank']],
      casual:[['ㄉㄨㄢˋㄉㄨㄢˋ','Leo張','段段'],['戴資淫娃','潘潘','小鬼'],['雙生','阿勳','麥基'],['打蚊子二人','Willan','阿宏'],['下一隊準備','Monk','Bosh'],['101','阿原','玄文']]},
    solarA:{comp:[['下一隊','小王','桑德'],['大腿中山羌','吉偉','聲揚'],['萬獸之業','阿業','阿怪'],['有點胖的R','胖胖','Little Raymond']],
      casual:[['剪刀石頭布','小布(Brian chang)','兔子'],['不適合才隊','小江（阿輝）','小歐'],['眼鏡熊','江肯','綸仔'],['人家第一次','嘎嘎','雪糕'],['姆丹花','姆斯','丹'],['喵語的費綸','貓貓','費綸']]},
    solarB:{comp:[['GANDARA','NATHAN','MIGGY'],['徹夜玩樂','阿徹','阿樂'],['TF-ING','小譚','小夫'],['桃氣包','包子（台南）','大桃']],
      casual:[['我不想流汗','小安','澤澤'],['志瑋我教練','AP','AG'],['曜餓死了','Shine','Ethan'],['第一次會痛','包子','許誠'],['翔叫霆都難','阿霆','翔'],['請打我隊友','阿信','阿樂']]},
    free:{comp:[['yoyo姬妹','阿又','阿京'],['大叔隊','阿浩','李柏偉'],['打我不隊','至哲','Yoyo'],['體質二十八','呱呱','伯翰']],
      casual:[['16羽之草','江金翰','莊畯崴'],['羽爆兄弟','包子','憂太'],['凡人修呆傳','美呆','阿凡'],['買台積就隊','小任','阿忠'],['嘿耶隊','四爺','Norman'],['帕莎小隊','小雨','波森']]},
  };
  const INVITE_ROSTER=[['雷熊嗷嗷2','熊','雷'],['羽球次等生','康恩','恩尼'],['慈母手聰線','李慈','聰聰'],['隨便取就好','凱文','和蒲'],['賴東東不錯','魚骨','賴賴'],['番茄嚇嚇叫','凱力','番茄'],['哎呀呀呀呀','小曹','小宇'],['甘巴爹','馬特','下巴']];

  // ---- 亂數（固定種子，資料穩定，兩頁一致）----
  let _sd=20260815;
  function rnd(){_sd=(_sd*9301+49297)%233280;return _sd/233280;}
  function resetSeed(s){_sd=s||20260815;}
  function shuffle(a){const r=a.slice();for(let i=r.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[r[i],r[j]]=[r[j],r[i]];}return r;}

  // ---- 徽記系統（與 bracket-tree 一致）----
  function ngon(cx,cy,r,n,rot){const p=[];for(let i=0;i<n;i++){const a=(rot||0)+i*2*Math.PI/n;p.push([cx+Math.cos(a)*r,cy+Math.sin(a)*r]);}return p;}
  function pstr(pts){return pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');}
  function EMB(C){return{
    poly:(pts,w)=>`<polygon points="${pstr(pts)}" fill="none" stroke="${C}" stroke-width="${w||5}" stroke-linejoin="round"/>`,
    fpoly:(pts)=>`<polygon points="${pstr(pts)}" fill="${C}"/>`,
    circ:(x,y,r,w)=>`<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${C}" stroke-width="${w||4}"/>`,
    dot:(x,y,r)=>`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r||4}" fill="${C}"/>`,
  };}
  const ECX=100,ECY=100;
  function embMini(key,C){
    const e=EMB(C);
    switch(key){
      case 'huanle':return e.poly(ngon(ECX,ECY,52,3,-Math.PI/2),6)+e.fpoly(ngon(ECX,ECY,14,3,-Math.PI/2));
      case 'yuzhou':return e.poly(ngon(ECX,ECY,52,3,-Math.PI/2),5)+e.poly(ngon(ECX,ECY,52,3,Math.PI/2),5);
      case 'poli':return e.poly([[ECX,ECY-54],[ECX+54,ECY],[ECX,ECY+54],[ECX-54,ECY]],6)+e.fpoly([[ECX,ECY-16],[ECX+16,ECY],[ECX,ECY+16],[ECX-16,ECY]]);
      case 'dachuan':return e.poly(ngon(ECX,ECY,50,4,0),6)+e.poly(ngon(ECX,ECY,30,4,Math.PI/4),4);
      case 'limao':return e.poly(ngon(ECX,ECY,52,6,0),6)+e.poly(ngon(ECX,ECY,26,6,0),4);
      case 'dangdang':return e.circ(ECX-13,ECY,46,5)+e.circ(ECX-13,ECY,26,4)+e.circ(ECX+13,ECY,46,5)+e.circ(ECX+13,ECY,26,4);
      case 'yuguang':{let s='';for(let arm=0;arm<3;arm++){let pts=[];for(let t=0;t<=22;t++){const r=6+t*2.1,a=arm*2*Math.PI/3+t*0.4;pts.push([ECX+Math.cos(a)*r,ECY+Math.sin(a)*r]);}s+=`<polyline points="${pstr(pts)}" fill="none" stroke="${C}" stroke-width="5" stroke-linecap="round"/>`;}return s;}
      case 'solarA':{let s='';for(let i=0;i<8;i++){const a=i*Math.PI/4-Math.PI/2;const tip=[ECX+Math.cos(a)*56,ECY+Math.sin(a)*56],bl=[ECX+Math.cos(a-0.13)*16,ECY+Math.sin(a-0.13)*16],br=[ECX+Math.cos(a+0.13)*16,ECY+Math.sin(a+0.13)*16];s+=(i%2?e.poly([tip,bl,[ECX,ECY],br],4):e.fpoly([tip,bl,[ECX,ECY],br]));}return s+e.fpoly(ngon(ECX,ECY,8,8,-Math.PI/2));}
      case 'solarB':{let s=e.circ(ECX,ECY,44,5)+e.circ(ECX,ECY,26,4);for(let i=0;i<12;i++){const a=i*Math.PI/6-Math.PI/2;const tip=[ECX+Math.cos(a)*60,ECY+Math.sin(a)*60],bl=[ECX+Math.cos(a-0.1)*44,ECY+Math.sin(a-0.1)*44],br=[ECX+Math.cos(a+0.1)*44,ECY+Math.sin(a+0.1)*44];s+=e.fpoly([tip,bl,br]);}return s+e.fpoly(ngon(ECX,ECY,10,12,0));}
      case 'free':{const arc=(r,st,sw,w)=>{const x1=ECX+Math.cos(st)*r,y1=ECY+Math.sin(st)*r,x2=ECX+Math.cos(st+sw)*r,y2=ECY+Math.sin(st+sw)*r,lg=sw>Math.PI?1:0;return `<path d="M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 ${lg},1 ${x2.toFixed(1)},${y2.toFixed(1)}" fill="none" stroke="${C}" stroke-width="${w}" stroke-linecap="round"/>`;};
        return arc(50,-1.6,4.8,6)+e.dot(ECX+Math.cos(-1.6)*50,ECY+Math.sin(-1.6)*50,4)+e.dot(ECX+Math.cos(3.2)*50,ECY+Math.sin(3.2)*50,4);}
    }
    return '';
  }
  function embChip(club){return `<svg viewBox="0 0 200 200"><circle cx="100" cy="100" r="86" fill="rgba(3,6,13,.6)" stroke="${club.c}" stroke-width="6"/>${embMini(club.key,club.c)}</svg>`;}

  // ---- 一場對戰（21 分單局）----
  let _tid=0;
  function playMatch(a,b){
    // 隨機勝負與比分（21 分制、單局）
    const aWin=rnd()<0.5;const lose=11+Math.floor(rnd()*9); // 敗方 11~19
    const sa=aWin?21:lose, sb=aWin?lose:21;
    const winner=aWin?a:b;
    a.gf+=sa;a.ga+=sb;b.gf+=sb;b.ga+=sa;
    if(aWin){a.w++;b.l++;}else{b.w++;a.l++;}
    const m={a,b,sa,sb,winner,sc:sa+'：'+sb};
    a.matches.push(m);b.matches.push(m);
    return m;
  }

  // ---- 失分率同分判定（簡章第九章）----
  // 1 勝場多者先；2 失分率＝同分隊互咬場次 得分÷失分，大者先；3 直接對戰；4 現場（保持順序）
  function rankGroup(teams,matches){
    // 先按勝場分群，同勝場的算「互咬失分率」
    const byW={};teams.forEach(t=>{(byW[t.w]=byW[t.w]||[]).push(t);});
    const ranked=[];
    Object.keys(byW).map(Number).sort((a,b)=>b-a).forEach(w=>{
      const grp=byW[w];
      if(grp.length===1){ranked.push(grp[0]);return;}
      // 互咬失分率：只計 grp 內彼此對戰的得失分
      const set=new Set(grp);
      grp.forEach(t=>{let gf=0,ga=0;
        matches.forEach(m=>{if((m.a===t||m.b===t)&&set.has(m.a)&&set.has(m.b)){
          if(m.a===t){gf+=m.sa;ga+=m.sb;}else{gf+=m.sb;ga+=m.sa;}}});
        t._ratio=ga>0?gf/ga:99;t._h2hgf=gf;t._h2hga=ga;});
      grp.sort((x,y)=>{
        if(y._ratio!==x._ratio)return y._ratio-x._ratio; // 失分率大者先
        // 直接對戰（僅兩隊同分同失分率時）
        if(grp.length===2){const dm=matches.find(m=>(m.a===x&&m.b===y)||(m.a===y&&m.b===x));
          if(dm)return dm.winner===x?-1:1;}
        return 0; // 三隊以上皆同→保持（現場裁定）
      });
      grp.forEach(t=>ranked.push(t));
    });
    return ranked;
  }

  // ---- 建立一隊 ----
  function mkTeam(club,lane,label,players){
    return {tid:'T'+(++_tid),club,clubObj:club,lane,label,players:players||null,
      w:0,l:0,gf:0,ga:0,matches:[],
      seedGroup:null,seedRank:null,tier:null,base:0};
  }

  // ---- 初賽一組（4 隊全循環 6 場 → 排名）----
  // 賽程表順序（round-robin 3 輪，每輪 2 場並行）
  function runGroup(gid,teams,gi){
    teams.forEach(t=>t.seedGroup=gid);
    const order=[[0,1],[2,3],[0,2],[1,3],[0,3],[1,2]];
    const times=['09:00','09:00','09:40','09:40','10:20','10:20'];
    const rounds=[1,1,2,2,3,3];
    const c1=(gi%5)*2+1,c2=c1+1;                 // 每組兩面場地（佔位，當天接真實）
    const courts=[c1,c2,c1,c2,c1,c2];
    const ms=[];
    order.forEach((pr,k)=>{
      const m=playMatch(teams[pr[0]],teams[pr[1]]);
      m.round=rounds[k];m.time=times[k];m.court=courts[k];m.slot=k;
      ms.push(m);
    });
    const rank=rankGroup(teams,ms);
    rank.forEach((t,i)=>t.seedRank=i+1);
    const played=3+Math.floor(rnd()*4);          // demo 模擬進度：3~6 場已完賽
    return {gid,teams,rank,matches:ms,played,gi,done:played>=6};
  }

  // ---- 完整賽事樹 ----
  function buildTournament(seed){
    resetSeed(seed);_tid=0;
    // 報名：10 團×(競技4+休閒6)=100 + 曜請8 = 108（真實名單 ROSTER）
    const comp=[],casual=[];
    CLUB_DATA.forEach(c=>{ROSTER[c.key].comp.forEach(t=>comp.push(mkTeam(c,'comp',t[0],[t[1],t[2]])));});
    CLUB_DATA.forEach(c=>{ROSTER[c.key].casual.forEach(t=>casual.push(mkTeam(c,'casual',t[0],[t[1],t[2]])));});

    // 分組（打散）：競技 10 組×4、休閒 15 組×4
    const compS=shuffle(comp), casS=shuffle(casual);
    const compGroups=[],casGroups=[];
    for(let g=0;g<10;g++)compGroups.push(runGroup('C-'+String(g+1).padStart(2,'0'),compS.slice(g*4,g*4+4),g));
    for(let g=0;g<15;g++)casGroups.push(runGroup('R-'+String(g+1).padStart(2,'0'),casS.slice(g*4,g*4+4),g));

    // 分流（賽道內，依 seedRank）：前二上階級、後二下階級
    const tiers={plat:[],gold:[],silver:[],bronze:[]};
    function assign(t,tier){t.tier=tier;t.base=TIER_META[tier].base;tiers[tier].push(t);}
    compGroups.forEach(g=>{g.rank.forEach((t,i)=>assign(t,i<2?'plat':'gold'));});
    casGroups.forEach(g=>{g.rank.forEach((t,i)=>assign(t,i<2?'silver':'bronze'));});

    return {
      qualGroups:{comp:compGroups,casual:casGroups},
      tiers,        // {plat:[20],gold:[20],silver:[30],bronze:[30]}
      clubData:CLUB_DATA,
    };
  }

  // ---- 曜請 8 隊（獨立賽，全循環）----
  const INVITE_CLUBS=[
    {key:'inv1',name:'曜請',c:'#ffc24b'},{key:'inv2',name:'曜請',c:'#ff8a3c'},
    {key:'inv3',name:'曜請',c:'#22d3ee'},{key:'inv4',name:'曜請',c:'#2ee6c8'},
    {key:'inv5',name:'曜請',c:'#a855f7'},{key:'inv6',name:'曜請',c:'#ff3ca6'},
    {key:'inv7',name:'曜請',c:'#a3e635'},{key:'inv8',name:'曜請',c:'#6b6bff'},
  ];
  function buildInvitational(){
    const T=INVITE_CLUBS.map((c,i)=>mkTeam(c,'invite',INVITE_ROSTER[i][0],[INVITE_ROSTER[i][1],INVITE_ROSTER[i][2]]));
    const ids=[0,1,2,3,4,5,6,7];const ms=[];
    for(let r=0;r<7;r++){
      for(let k=0;k<4;k++){const m=playMatch(T[ids[k]],T[ids[7-k]]);m.round=r+1;m.slot=r*4+k;ms.push(m);}
      ids.splice(1,0,ids.pop());
    }
    const rank=rankGroup(T,ms);rank.forEach((t,i)=>{t.seedRank=i+1;t.tier='invite';});
    return {teams:T,rank,matches:ms};
  }

  // ---- 108 隊統一清單（查詢頁 / 未來全站戰績卡共用真相）----
  // ---- DEMO 球員暱稱池（示範用，正式名單確定後於此替換單一來源）----
  const NICK_POOL=['阿明','小華','阿宏','建志','俊翔','家豪','宗翰','冠廷','柏翰','承恩',
    '志明','雅婷','怡君','國豪','大頭','阿凱','小賴','阿德','昱翔','子軒',
    '偉哲','孟儒','政緯','宥辰','翊誠','品睿','宸瑋','裕翔','俊宇','冠宇',
    '阿龍','小傑','阿信','世偉','建宏','俊傑','明哲','宗霖','宇軒','柏宇'];
  function demoPlayers(tid){
    // 依 tid 穩定取兩個不重複暱稱
    let seed=0;for(let i=0;i<tid.length;i++)seed=(seed*31+tid.charCodeAt(i))%99991;
    const a=seed%NICK_POOL.length;let b=(seed*7+13)%NICK_POOL.length;if(b===a)b=(b+1)%NICK_POOL.length;
    return [NICK_POOL[a],NICK_POOL[b]];
  }

  function buildAllTeams(seed){
    const tn=buildTournament(seed);
    const inv=buildInvitational();
    const out=[];
    function push(t,track,groupLabel){
      const tm=t.tier==='invite'?{name:'曜請',en:'INVITATIONAL',col:'#ffc24b'}:TIER_META[t.tier];
      out.push({
        tid:t.tid,label:t.label,players:t.players||demoPlayers(t.tid),
        clubKey:t.clubObj.key,club:t.clubObj.name,clubFull:t.clubObj.full||t.clubObj.name,clubColor:t.clubObj.c,
        track,group:groupLabel,
        tier:t.tier,tierName:tm.name,tierColor:tm.col,base:t.base||0,
        w:t.w,l:t.l,gf:t.gf,ga:t.ga,rank:t.seedRank,matches:t.matches,
      });
    }
    tn.qualGroups.comp.forEach(g=>g.teams.forEach(t=>push(t,'競技',g.gid)));
    tn.qualGroups.casual.forEach(g=>g.teams.forEach(t=>push(t,'休閒',g.gid)));
    inv.teams.forEach(t=>push(t,'曜請','曜請組'));
    return {teams:out,tournament:tn,invitational:inv};
  }

  // ---- 匯出 ----
  global.SolarCupData={
    CLUB_DATA,CLUB_BY_KEY,NINE,FREE,TIER_META,INVITE_CLUBS,
    ngon,pstr,EMB,embMini,embChip,
    rankGroup,buildTournament,buildInvitational,buildAllTeams,demoPlayers,
    rnd,resetSeed,
  };
})(typeof window!=='undefined'?window:this);
