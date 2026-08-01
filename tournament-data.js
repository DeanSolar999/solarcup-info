/* ============================================================
   SOLAR CUP TWO · 共用資料層 tournament-data.js
   qualifying.html 與 bracket-tree.html 共用同一份賽事資料
   一次生成：報名 → 資格賽 25 組 → 總得失分率分流 → 四階級
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
    dachuan:{comp:[['鴛鴛相報','阿浩','Rick'],['TD','阿鈦','莫迪'],['來TGB打','大熊','誠誠'],['就來試試','亞哲','駿']],
      casual:[['支援TGB','挨滴','子銘'],['Ho力薛','薛寶','瓦力'],['發起就掛網','Nice','俊恩'],['摸蜆仔兼seiko','Jeff','YY'],['樺騏來','阿樺','騏騏'],['請假來比賽','夯特','小澤']]},
    dangdang:{comp:[['干飯二人組','Nick','建宏'],['早餐暈碳','玉米','饅頭'],['恐龍扛狼扛','樹樹','克里斯'],['余翔拳','大翔','小余']],
      casual:[['古咕古','小古','小林'],['JoeJoe雨林','宇霖','Joe'],['柚呆又菜','柚子','皓呆'],['線條洨狗','普爾','Hank'],['OOHH','歐文','阿弘'],['馬Leo','Leo翔','馬力歐']]},
    free:{comp:[['yoyo姬妹','阿又','阿京'],['大叔隊','阿浩','李柏偉'],['打我不隊','至哲','Yoyo'],['體脂二十八','呱呱','伯翰']],
      casual:[['16羽之草','江金翰','莊畯崴'],['羽爆兄弟','肉包','憂太'],['凡人修呆傳','美呆','阿凡'],['買台積就隊','小任','阿忠'],['嘿耶隊','四爺','Norman'],['帕莎小隊','小雨','波森']]},
    huanle:{comp:[['喵喵喵喵喵','湯包','阿達'],['目前沒想法','小P','亮亮'],['阿嬤特拉斯','勝利','小村'],['我不想比賽','小溫','Steven']],
      casual:[['放過老人家','丹尼','東于'],['打那個胖子','達比','阿林'],['伊森吃～恩','包恩','Ethan'],['飛長丸美','丸弟','小飛'],['可攻也可守','小柯','大雄'],['自由自在瘋','Ben','阿風']]},
    limao:{comp:[['狸貓金Carry','牛牛','Kerry'],['萊一群狸貓','Sean','阿群'],['太子變狸貓','Darren','喬治'],['勿《惹》 Me','Jerry','烏克']],
      casual:[['出事了阿北','宸宸','阿和'],['啊對對對隊','小海','Howard'],['狸貓愛波霸','Eddie','Mango'],['禮貌的狸貓','柴犬','阿堯'],['耍廢的狸貓','Hank','翼麟'],['GOGO齊狸王','尼克','KC']]},
    poli:{comp:[['魄力代表隊','亞馬','Frank'],['大調查小學','阿嚕','小狐狸'],['Skip','Jack','小阿明'],['還在磨合中','Bernie','小豪']],
      casual:[['荖蒻慚冰','Kent','村長'],['揪蛋幾勒','阿比','阿力'],['電力十足','小志','皮卡丘'],['歐恩吸壹 ONCE','Neil','Joe'],['兩隻噗嚨共','武','龍'],['芬散注意力','阿芬','威力']]},
    solarA:{comp:[['下一隊','小王','桑德'],['大腿中山羌','吉偉','聲揚'],['萬獸之業','阿業','阿怪'],['有點胖的R','胖胖','Little Raymond']],
      casual:[['剪刀石頭布','小布','兔子'],['不適合才隊','小江','小歐'],['眼鏡熊','江肯','綸仔'],['人家第一次','嘎嘎','雪糕'],['姆丹花','姆斯','丹'],['喵語的費綸','貓貓','費綸']]},
    solarB:{comp:[['GANDARA','NATHAN','MIGGY'],['徹夜玩樂','阿徹','阿樂'],['TF-ING','小譚','小夫'],['桃氣包','小籠包','大桃']],
      casual:[['我不想流汗','小安','澤澤'],['志瑋我教練','AP','AG'],['曜餓死了','Shine','Ethan'],['第一次會痛','包子','許誠'],['翔叫霆都難','阿霆','翔'],['請打我隊友','阿信','阿樂']]},
    yuguang:{comp:[['V.SOP來一杯','Vernon','Steven'],['裕擎故縱','裕智','擎元'],['爽歪歪','Shawn','YY'],['Han悠','小悠','Hank']],
      casual:[['ㄉㄨㄢˋㄉㄨㄢˋ','Leo張','段段'],['戴資淫娃','潘潘','小鬼'],['雙生','阿勳','麥基'],['打蚊子二人','Willan','阿宏'],['下一隊準備','Monk','Bosh'],['101','阿原','玄文']]},
    yuzhou:{comp:[['琳達雙余座','Carry','尾巴'],['淇淇與弟弟','淇淇','柴克'],['羽你亂鬥','肥力','哈倫'],['我們想一下','Kai','黑輪']],
      casual:[['野雞出來浪','俊介','Ian'],['謙BU可擋','咘咘','謙謙'],['吃屎吉娃娃','小B','YaYa'],['蔥爆吉娃娃','Ryan QoQ','James VoV'],['明年40了','達達','阿杰'],['媽呀傑奶大','James','W']]},
  };
  const INVITE_ROSTER=[['雷熊嗷嗷2','熊','雷'],['羽球次等生','康恩','恩尼'],['慈母手聰線','李慈','聰聰'],['隨便取就好','凱文','和蒲'],['賴東東不錯','魚骨','賴賴'],['番茄嚇嚇叫','凱力','番茄'],['哎呀呀呀呀','小曹','小宇'],['甘巴爹','馬特','下巴']];

  // ---- 官方資格賽賽程（雲端 2_資格賽成績 實抓：場次/時間/場地/對戰兩隊，勿手改）----
  const QUAL_SCHEDULE={
    '競資-A':[{n:1,time:'08:40',court:1,a:'徹夜玩樂',b:'勿《惹》 Me'},{n:6,time:'08:40',court:6,a:'干飯二人組',b:'體脂二十八'},{n:21,time:'09:10',court:1,a:'徹夜玩樂',b:'干飯二人組'},{n:26,time:'09:10',court:6,a:'勿《惹》 Me',b:'體脂二十八'},{n:41,time:'09:40',court:1,a:'徹夜玩樂',b:'體脂二十八'},{n:46,time:'09:40',court:6,a:'勿《惹》 Me',b:'干飯二人組'}],
    '競資-B':[{n:2,time:'08:40',court:2,a:'V.SOP來一杯',b:'魄力代表隊'},{n:7,time:'08:40',court:7,a:'打我不隊',b:'萬獸之業'},{n:22,time:'09:10',court:2,a:'V.SOP來一杯',b:'打我不隊'},{n:27,time:'09:10',court:7,a:'魄力代表隊',b:'萬獸之業'},{n:42,time:'09:40',court:2,a:'V.SOP來一杯',b:'萬獸之業'},{n:47,time:'09:40',court:7,a:'魄力代表隊',b:'打我不隊'}],
    '競資-C':[{n:3,time:'08:40',court:3,a:'GANDARA',b:'早餐暈碳'},{n:8,time:'08:40',court:8,a:'來TGB打',b:'淇淇與弟弟'},{n:23,time:'09:10',court:3,a:'GANDARA',b:'來TGB打'},{n:28,time:'09:10',court:8,a:'早餐暈碳',b:'淇淇與弟弟'},{n:43,time:'09:40',court:3,a:'GANDARA',b:'淇淇與弟弟'},{n:48,time:'09:40',court:8,a:'早餐暈碳',b:'來TGB打'}],
    '競資-D':[{n:4,time:'08:40',court:4,a:'太子變狸貓',b:'有點胖的R'},{n:9,time:'08:40',court:9,a:'大叔隊',b:'目前沒想法'},{n:24,time:'09:10',court:4,a:'太子變狸貓',b:'大叔隊'},{n:29,time:'09:10',court:9,a:'有點胖的R',b:'目前沒想法'},{n:44,time:'09:40',court:4,a:'太子變狸貓',b:'目前沒想法'},{n:49,time:'09:40',court:9,a:'有點胖的R',b:'大叔隊'}],
    '競資-E':[{n:5,time:'08:40',court:5,a:'TF-ING',b:'大調查小學'},{n:10,time:'08:40',court:10,a:'余翔拳',b:'我們想一下'},{n:25,time:'09:10',court:5,a:'TF-ING',b:'余翔拳'},{n:30,time:'09:10',court:10,a:'大調查小學',b:'我們想一下'},{n:45,time:'09:40',court:5,a:'TF-ING',b:'我們想一下'},{n:50,time:'09:40',court:10,a:'大調查小學',b:'余翔拳'}],
    '競資-F':[{n:11,time:'08:55',court:1,a:'萊一群狸貓',b:'裕擎故縱'},{n:16,time:'08:55',court:6,a:'大腿中山羌',b:'阿嬤特拉斯'},{n:31,time:'09:25',court:1,a:'萊一群狸貓',b:'大腿中山羌'},{n:36,time:'09:25',court:6,a:'裕擎故縱',b:'阿嬤特拉斯'},{n:51,time:'09:55',court:1,a:'萊一群狸貓',b:'阿嬤特拉斯'},{n:56,time:'09:55',court:6,a:'裕擎故縱',b:'大腿中山羌'}],
    '競資-G':[{n:12,time:'08:55',court:2,a:'桃氣包',b:'還在磨合中'},{n:17,time:'08:55',court:7,a:'TD',b:'琳達雙余座'},{n:32,time:'09:25',court:2,a:'桃氣包',b:'TD'},{n:37,time:'09:25',court:7,a:'還在磨合中',b:'琳達雙余座'},{n:52,time:'09:55',court:2,a:'桃氣包',b:'琳達雙余座'},{n:57,time:'09:55',court:7,a:'還在磨合中',b:'TD'}],
    '競資-H':[{n:13,time:'08:55',court:3,a:'爽歪歪',b:'喵喵喵喵喵'},{n:18,time:'08:55',court:8,a:'下一隊',b:'就來試試'},{n:33,time:'09:25',court:3,a:'爽歪歪',b:'下一隊'},{n:38,time:'09:25',court:8,a:'喵喵喵喵喵',b:'就來試試'},{n:53,time:'09:55',court:3,a:'爽歪歪',b:'就來試試'},{n:58,time:'09:55',court:8,a:'喵喵喵喵喵',b:'下一隊'}],
    '競資-I':[{n:14,time:'08:55',court:4,a:'Han悠',b:'Skip'},{n:19,time:'08:55',court:9,a:'鴛鴛相報',b:'yoyo姬妹'},{n:34,time:'09:25',court:4,a:'Han悠',b:'鴛鴛相報'},{n:39,time:'09:25',court:9,a:'Skip',b:'yoyo姬妹'},{n:54,time:'09:55',court:4,a:'Han悠',b:'yoyo姬妹'},{n:59,time:'09:55',court:9,a:'Skip',b:'鴛鴛相報'}],
    '競資-J':[{n:15,time:'08:55',court:5,a:'狸貓金Carry',b:'我不想比賽'},{n:20,time:'08:55',court:10,a:'恐龍扛狼扛',b:'羽你亂鬥'},{n:35,time:'09:25',court:5,a:'狸貓金Carry',b:'恐龍扛狼扛'},{n:40,time:'09:25',court:10,a:'我不想比賽',b:'羽你亂鬥'},{n:55,time:'09:55',court:5,a:'狸貓金Carry',b:'羽你亂鬥'},{n:60,time:'09:55',court:10,a:'我不想比賽',b:'恐龍扛狼扛'}],
    '休資-A':[{n:61,time:'10:10',court:1,a:'荖蒻慚冰',b:'請打我隊友'},{n:66,time:'10:10',court:6,a:'放過老人家',b:'打蚊子二人'},{n:91,time:'10:55',court:1,a:'荖蒻慚冰',b:'放過老人家'},{n:96,time:'10:55',court:6,a:'請打我隊友',b:'打蚊子二人'},{n:121,time:'12:05',court:1,a:'荖蒻慚冰',b:'打蚊子二人'},{n:126,time:'12:05',court:6,a:'請打我隊友',b:'放過老人家'}],
    '休資-B':[{n:62,time:'10:10',court:2,a:'GOGO齊狸王',b:'吃屎吉娃娃'},{n:67,time:'10:10',court:7,a:'打那個胖子',b:'喵語的費綸'},{n:92,time:'10:55',court:2,a:'GOGO齊狸王',b:'打那個胖子'},{n:97,time:'10:55',court:7,a:'吃屎吉娃娃',b:'喵語的費綸'},{n:122,time:'12:05',court:2,a:'GOGO齊狸王',b:'喵語的費綸'},{n:127,time:'12:05',court:7,a:'吃屎吉娃娃',b:'打那個胖子'}],
    '休資-C':[{n:63,time:'10:10',court:3,a:'柚呆又菜',b:'志瑋我教練'},{n:68,time:'10:10',court:8,a:'羽爆兄弟',b:'不適合才隊'},{n:93,time:'10:55',court:3,a:'柚呆又菜',b:'羽爆兄弟'},{n:98,time:'10:55',court:8,a:'志瑋我教練',b:'不適合才隊'},{n:123,time:'12:05',court:3,a:'柚呆又菜',b:'不適合才隊'},{n:128,time:'12:05',court:8,a:'志瑋我教練',b:'羽爆兄弟'}],
    '休資-D':[{n:64,time:'10:10',court:4,a:'嘿耶隊',b:'明年40了'},{n:69,time:'10:10',court:9,a:'摸蜆仔兼seiko',b:'線條洨狗'},{n:94,time:'10:55',court:4,a:'嘿耶隊',b:'摸蜆仔兼seiko'},{n:99,time:'10:55',court:9,a:'明年40了',b:'線條洨狗'},{n:124,time:'12:05',court:4,a:'嘿耶隊',b:'線條洨狗'},{n:129,time:'12:05',court:9,a:'明年40了',b:'摸蜆仔兼seiko'}],
    '休資-E':[{n:65,time:'10:10',court:5,a:'兩隻噗嚨共',b:'曜餓死了'},{n:70,time:'10:10',court:10,a:'媽呀傑奶大',b:'馬Leo'},{n:95,time:'10:55',court:5,a:'兩隻噗嚨共',b:'媽呀傑奶大'},{n:100,time:'10:55',court:10,a:'曜餓死了',b:'馬Leo'},{n:125,time:'12:05',court:5,a:'兩隻噗嚨共',b:'馬Leo'},{n:130,time:'12:05',court:10,a:'曜餓死了',b:'媽呀傑奶大'}],
    '休資-F':[{n:71,time:'10:25',court:1,a:'凡人修呆傳',b:'禮貌的狸貓'},{n:76,time:'10:25',court:6,a:'Ho力薛',b:'ㄉㄨㄢˋㄉㄨㄢˋ'},{n:101,time:'11:10',court:1,a:'凡人修呆傳',b:'Ho力薛'},{n:106,time:'11:10',court:6,a:'禮貌的狸貓',b:'ㄉㄨㄢˋㄉㄨㄢˋ'},{n:131,time:'12:20',court:1,a:'凡人修呆傳',b:'ㄉㄨㄢˋㄉㄨㄢˋ'},{n:136,time:'12:20',court:6,a:'禮貌的狸貓',b:'Ho力薛'}],
    '休資-G':[{n:72,time:'10:25',court:2,a:'電力十足',b:'翔叫霆都難'},{n:77,time:'10:25',court:7,a:'飛長丸美',b:'JoeJoe雨林'},{n:102,time:'11:10',court:2,a:'電力十足',b:'飛長丸美'},{n:107,time:'11:10',court:7,a:'翔叫霆都難',b:'JoeJoe雨林'},{n:132,time:'12:20',court:2,a:'電力十足',b:'JoeJoe雨林'},{n:137,time:'12:20',court:7,a:'翔叫霆都難',b:'飛長丸美'}],
    '休資-H':[{n:73,time:'10:25',court:3,a:'帕莎小隊',b:'狸貓愛波霸'},{n:78,time:'10:25',court:8,a:'支援TGB',b:'下一隊準備'},{n:103,time:'11:10',court:3,a:'帕莎小隊',b:'支援TGB'},{n:108,time:'11:10',court:8,a:'狸貓愛波霸',b:'下一隊準備'},{n:133,time:'12:20',court:3,a:'帕莎小隊',b:'下一隊準備'},{n:138,time:'12:20',court:8,a:'狸貓愛波霸',b:'支援TGB'}],
    '休資-I':[{n:74,time:'10:25',court:4,a:'16羽之草',b:'第一次會痛'},{n:79,time:'10:25',court:9,a:'可攻也可守',b:'古咕古'},{n:104,time:'11:10',court:4,a:'16羽之草',b:'可攻也可守'},{n:109,time:'11:10',court:9,a:'第一次會痛',b:'古咕古'},{n:134,time:'12:20',court:4,a:'16羽之草',b:'古咕古'},{n:139,time:'12:20',court:9,a:'第一次會痛',b:'可攻也可守'}],
    '休資-J':[{n:75,time:'10:25',court:5,a:'歐恩吸壹 ONCE',b:'出事了阿北'},{n:80,time:'10:25',court:10,a:'姆丹花',b:'請假來比賽'},{n:105,time:'11:10',court:5,a:'歐恩吸壹 ONCE',b:'姆丹花'},{n:110,time:'11:10',court:10,a:'出事了阿北',b:'請假來比賽'},{n:135,time:'12:20',court:5,a:'歐恩吸壹 ONCE',b:'請假來比賽'},{n:140,time:'12:20',court:10,a:'出事了阿北',b:'姆丹花'}],
    '休資-K':[{n:81,time:'10:40',court:1,a:'揪蛋幾勒',b:'發起就掛網'},{n:86,time:'10:40',court:6,a:'伊森吃～恩',b:'101'},{n:111,time:'11:50',court:1,a:'揪蛋幾勒',b:'伊森吃～恩'},{n:116,time:'11:50',court:6,a:'發起就掛網',b:'101'},{n:141,time:'12:35',court:1,a:'揪蛋幾勒',b:'101'},{n:146,time:'12:35',court:6,a:'發起就掛網',b:'伊森吃～恩'}],
    '休資-L':[{n:82,time:'10:40',court:2,a:'蔥爆吉娃娃',b:'啊對對對隊'},{n:87,time:'10:40',court:7,a:'OOHH',b:'人家第一次'},{n:112,time:'11:50',court:2,a:'蔥爆吉娃娃',b:'OOHH'},{n:117,time:'11:50',court:7,a:'啊對對對隊',b:'人家第一次'},{n:142,time:'12:35',court:2,a:'蔥爆吉娃娃',b:'人家第一次'},{n:147,time:'12:35',court:7,a:'啊對對對隊',b:'OOHH'}],
    '休資-M':[{n:83,time:'10:40',court:3,a:'芬散注意力',b:'我不想流汗'},{n:88,time:'10:40',court:8,a:'買台積就隊',b:'戴資淫娃'},{n:113,time:'11:50',court:3,a:'芬散注意力',b:'買台積就隊'},{n:118,time:'11:50',court:8,a:'我不想流汗',b:'戴資淫娃'},{n:143,time:'12:35',court:3,a:'芬散注意力',b:'戴資淫娃'},{n:148,time:'12:35',court:8,a:'我不想流汗',b:'買台積就隊'}],
    '休資-N':[{n:84,time:'10:40',court:4,a:'謙BU可擋',b:'耍廢的狸貓'},{n:89,time:'10:40',court:9,a:'剪刀石頭布',b:'雙生'},{n:114,time:'11:50',court:4,a:'謙BU可擋',b:'剪刀石頭布'},{n:119,time:'11:50',court:9,a:'耍廢的狸貓',b:'雙生'},{n:144,time:'12:35',court:4,a:'謙BU可擋',b:'雙生'},{n:149,time:'12:35',court:9,a:'耍廢的狸貓',b:'剪刀石頭布'}],
    '休資-O':[{n:85,time:'10:40',court:5,a:'樺騏來',b:'眼鏡熊'},{n:90,time:'10:40',court:10,a:'自由自在瘋',b:'野雞出來浪'},{n:115,time:'11:50',court:5,a:'樺騏來',b:'自由自在瘋'},{n:120,time:'11:50',court:10,a:'眼鏡熊',b:'野雞出來浪'},{n:145,time:'12:35',court:5,a:'樺騏來',b:'野雞出來浪'},{n:150,time:'12:35',court:10,a:'眼鏡熊',b:'自由自在瘋'}],
  };


  // ---- 隊名→分組代碼映射（從雲端「1_隊伍名冊」分組欄萃取；不再 shuffle）----
  const GROUP_MAP={
    '鴛鴛相報':'競資-I','TD':'競資-G','來TGB打':'競資-C','就來試試':'競資-H',
    '支援TGB':'休資-H','Ho力薛':'休資-F','發起就掛網':'休資-K','摸蜆仔兼seiko':'休資-D','樺騏來':'休資-O','請假來比賽':'休資-J',
    '干飯二人組':'競資-A','早餐暈碳':'競資-C','恐龍扛狼扛':'競資-J','余翔拳':'競資-E',
    '古咕古':'休資-I','JoeJoe雨林':'休資-G','柚呆又菜':'休資-C','線條洨狗':'休資-D','OOHH':'休資-L','馬Leo':'休資-E',
    'yoyo姬妹':'競資-I','大叔隊':'競資-D','打我不隊':'競資-B','體脂二十八':'競資-A',
    '16羽之草':'休資-I','羽爆兄弟':'休資-C','凡人修呆傳':'休資-F','買台積就隊':'休資-M','嘿耶隊':'休資-D','帕莎小隊':'休資-H',
    '喵喵喵喵喵':'競資-H','目前沒想法':'競資-D','阿嬤特拉斯':'競資-F','我不想比賽':'競資-J',
    '放過老人家':'休資-A','打那個胖子':'休資-B','伊森吃～恩':'休資-K','飛長丸美':'休資-G','可攻也可守':'休資-I','自由自在瘋':'休資-O',
    '狸貓金Carry':'競資-J','萊一群狸貓':'競資-F','太子變狸貓':'競資-D','勿《惹》 Me':'競資-A',
    '出事了阿北':'休資-J','啊對對對隊':'休資-L','狸貓愛波霸':'休資-H','禮貌的狸貓':'休資-F','耍廢的狸貓':'休資-N','GOGO齊狸王':'休資-B',
    '魄力代表隊':'競資-B','大調查小學':'競資-E','Skip':'競資-I','還在磨合中':'競資-G',
    '荖蒻慚冰':'休資-A','揪蛋幾勒':'休資-K','電力十足':'休資-G','歐恩吸壹 ONCE':'休資-J','兩隻噗嚨共':'休資-E','芬散注意力':'休資-M',
    '下一隊':'競資-H','大腿中山羌':'競資-F','萬獸之業':'競資-B','有點胖的R':'競資-D',
    '剪刀石頭布':'休資-N','不適合才隊':'休資-C','眼鏡熊':'休資-O','人家第一次':'休資-L','姆丹花':'休資-J','喵語的費綸':'休資-B',
    'GANDARA':'競資-C','徹夜玩樂':'競資-A','TF-ING':'競資-E','桃氣包':'競資-G',
    '我不想流汗':'休資-M','志瑋我教練':'休資-C','曜餓死了':'休資-E','第一次會痛':'休資-I','翔叫霆都難':'休資-G','請打我隊友':'休資-A',
    'V.SOP來一杯':'競資-B','裕擎故縱':'競資-F','爽歪歪':'競資-H','Han悠':'競資-I',
    'ㄉㄨㄢˋㄉㄨㄢˋ':'休資-F','戴資淫娃':'休資-M','雙生':'休資-N','打蚊子二人':'休資-A','下一隊準備':'休資-H','101':'休資-K',
    '琳達雙余座':'競資-G','淇淇與弟弟':'競資-C','羽你亂鬥':'競資-J','我們想一下':'競資-E',
    '野雞出來浪':'休資-O','謙BU可擋':'休資-N','吃屎吉娃娃':'休資-B','蔥爆吉娃娃':'休資-L','明年40了':'休資-D','媽呀傑奶大':'休資-E',
  };

  // ---- 亂數（固定種子，資料穩定，兩頁一致）----

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

  // ---- 雲端結果來源（唯一真相：後端資料庫 8_發布_戰情看板）----
  // 由各頁在取得 SolarCupLive.load() 後呼叫 setLive(data) 注入；未注入＝全部未開打。
  // 站上不再有任何模擬比分，賽前顯示真實賽程但無分數。
  let LIVE=null;
  function setLive(d){LIVE=d||null;}
  function liveResult(n){
    if(!LIVE||!LIVE.matches||n==null)return null;
    const r=LIVE.matches[String(n)];
    return (r&&r.done)?r:null;
  }
  function hasLive(){return !!(LIVE&&LIVE.hasReal);}

  // ---- 一場對戰（21 分單局）----
  // 有雲端分數＝真實結果；沒有＝未開打（sa/sb 為 null，不計入任何統計）
  let _tid=0;
  function playMatch(a,b,n){
    const r=liveResult(n);
    if(!r){
      const m={a,b,sa:null,sb:null,winner:null,done:false,sc:'',n:n};
      a.matches.push(m);b.matches.push(m);
      return m;
    }
    const sa=r.sa,sb=r.sb;
    const winner=sa>sb?a:b;                // 21 分單局無平手
    a.gf+=sa;a.ga+=sb;b.gf+=sb;b.ga+=sa;
    if(winner===a){a.w++;b.l++;}else{b.w++;a.l++;}
    const m={a,b,sa,sb,winner,done:true,sc:sa+'：'+sb,n:n};
    a.matches.push(m);b.matches.push(m);
    return m;
  }

  // ---- 同分判定（官方秩序冊第六章）----
  // 官方秩序冊第六章：1 勝場多者先；2 總得失分率＝該循環全部場次 總得分÷總失分，大者先；3 兩隊對戰勝負；4 抽籤（保持順序）
  function rankGroup(teams,matches){
    // 先按勝場分群，同勝場者比總得失分率
    const byW={};teams.forEach(t=>{(byW[t.w]=byW[t.w]||[]).push(t);});
    const ranked=[];
    Object.keys(byW).map(Number).sort((a,b)=>b-a).forEach(w=>{
      const grp=byW[w];
      if(grp.length===1){ranked.push(grp[0]);return;}
      // 總得失分率：計該隊在此循環的所有場次得失分（非僅同分隊互相對戰）
      // 只計已完賽場次；失分率 sentinel 統一 999（與後端 MIN(IFERROR(...,999),999) 一致）
      grp.forEach(t=>{let gf=0,ga=0;
        matches.forEach(m=>{if(!m.done)return;
          if(m.a===t){gf+=m.sa;ga+=m.sb;}else if(m.b===t){gf+=m.sb;ga+=m.sa;}});
        t._ratio=ga>0?Math.min(gf/ga,999):999;t._h2hgf=gf;t._h2hga=ga;});
      grp.sort((x,y)=>{
        if(y._ratio!==x._ratio)return y._ratio-x._ratio; // 總得失分率大者先
        // 兩隊對戰勝負（僅兩隊同分同得失分率時）
        if(grp.length===2){const dm=matches.find(m=>(m.a===x&&m.b===y)||(m.a===y&&m.b===x));
          if(dm)return dm.winner===x?-1:1;}
        return 0; // 三隊以上皆同→保持（現場抽籤）
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

  // ---- 資格賽一組（4 隊全循環 6 場 → 排名）----
  // 賽程表順序（round-robin 3 輪，每輪 2 場並行）
  function runGroup(gid,teams,gi){
    teams.forEach(t=>t.seedGroup=gid);
    const byName={};teams.forEach(t=>{byName[t.label]=t;});
    const schedule=QUAL_SCHEDULE[gid]||[];
    const ms=[];
    // 完全依官方賽程：對戰組合、時間、場地、場次編號皆照抄，不再用公式推算
    schedule.forEach((s,k)=>{
      const A=byName[s.a],B=byName[s.b];
      if(!A||!B)return;
      const m=playMatch(A,B,s.n);
      m.round=Math.floor(k/2)+1;m.time=s.time;m.court=s.court;m.slot=k;
      ms.push(m);
    });
    const rank=rankGroup(teams,ms);
    rank.forEach((t,i)=>t.seedRank=i+1);
    const played=ms.filter(m=>m.done).length;    // 真實完賽場數（非模擬進度）
    return {gid,teams,rank,matches:ms,played,gi,done:played>=ms.length&&ms.length>0};
  }

  // ---- 完整賽事樹 ----
  function buildTournament(live){
    if(live!==undefined)setLive(live);
    _tid=0;
    // 報名：10 團×(競技4+休閒6)=100 + 曜請8 = 108（真實名單 ROSTER）
    const comp=[],casual=[];
    CLUB_DATA.forEach(c=>{ROSTER[c.key].comp.forEach(t=>comp.push(mkTeam(c,'comp',t[0],[t[1],t[2]])));});
    CLUB_DATA.forEach(c=>{ROSTER[c.key].casual.forEach(t=>casual.push(mkTeam(c,'casual',t[0],[t[1],t[2]])));});

    // 分組（依雲端「分組」欄固定分派，不再 shuffle）：競技 10 組×4、休閒 15 組×4
    // 建立「分組代碼→隊伍」的映射
    const groupMap={};
    comp.forEach(t=>{const gid=GROUP_MAP[t.label];if(!groupMap[gid])groupMap[gid]=[];groupMap[gid].push(t);});
    casual.forEach(t=>{const gid=GROUP_MAP[t.label];if(!groupMap[gid])groupMap[gid]=[];groupMap[gid].push(t);});

    const compGroups=[],casGroups=[];
    // 組別代號對應賽程主檔：競技資格 競資-A…J（10 組）、休閒資格 休資-A…O（15 組）
    for(let g=0;g<10;g++){
      const gid='競資-'+String.fromCharCode(65+g);
      const teams=groupMap[gid]||[];
      compGroups.push(runGroup(gid,teams,g));
    }
    for(let g=0;g<15;g++){
      const gid='休資-'+String.fromCharCode(65+g);
      const teams=groupMap[gid]||[];
      casGroups.push(runGroup(gid,teams,g));
    }

    // 分流：該組 6 場全數完賽才定案（未完賽 tier=null＝待定，不預先洩漏分級）
    // 有雲端「自動晉級」欄就以它為準（後端才是計分真相），否則依組內排名前二/後二
    const CN2KEY={'白金':'plat','黃金':'gold','白銀':'silver','青銅':'bronze'};
    const tierByName={};
    if(LIVE&&LIVE.qualRank)Object.keys(LIVE.qualRank).forEach(id=>{
      const q=LIVE.qualRank[id];if(q&&q.name&&CN2KEY[q.tier])tierByName[q.name]=CN2KEY[q.tier];});
    const tiers={plat:[],gold:[],silver:[],bronze:[]};
    function assign(t,tier){t.tier=tier;t.base=TIER_META[tier].base;tiers[tier].push(t);}
    function flow(groups,up,dn){groups.forEach(g=>{
      if(!g.done)return;                                  // 未完賽：維持 tier=null
      g.rank.forEach((t,i)=>assign(t,tierByName[t.label]||(i<2?up:dn)));
    });}
    flow(compGroups,'plat','gold');
    flow(casGroups,'silver','bronze');

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

  // ---- 曜請組 28 場官方賽程（場次編號｜場地｜起｜訖｜隊A index｜隊B index）----
  const INVITE_SCHEDULE=[
    [157, 7,'12:50','13:05',0,1],[158, 8,'12:50','13:05',2,3],[159, 9,'12:50','13:05',4,5],[160,10,'12:50','13:05',6,7],
    [179, 9,'13:20','13:35',0,2],[180,10,'13:20','13:35',1,3],[189, 9,'13:35','13:50',4,6],[190,10,'13:35','13:50',5,7],
    [209, 9,'14:05','14:20',0,7],[210,10,'14:05','14:20',1,6],[229, 9,'14:35','14:50',2,5],[230,10,'14:35','14:50',3,4],
    [247, 9,'15:05','15:20',0,4],[248,10,'15:05','15:20',1,5],[257, 9,'15:20','15:35',2,6],[258,10,'15:20','15:35',3,7],
    [275, 9,'15:50','16:05',0,3],[276,10,'15:50','16:05',1,2],[285, 9,'16:05','16:20',5,6],[286,10,'16:05','16:20',4,7],
    [295, 7,'16:35','16:50',0,6],[296, 8,'16:35','16:50',3,5],[297, 9,'16:35','16:50',1,4],[298,10,'16:35','16:50',2,7],
    [307, 7,'17:05','17:20',0,5],[308, 8,'17:05','17:20',2,4],[309, 9,'17:05','17:20',1,7],[310,10,'17:05','17:20',3,6],
  ];

  function buildInvitational(){
    const T=INVITE_CLUBS.map((c,i)=>mkTeam(c,'invite',INVITE_ROSTER[i][0],[INVITE_ROSTER[i][1],INVITE_ROSTER[i][2]]));
    const ms=INVITE_SCHEDULE.map((sc,i)=>{
      const m=playMatch(T[sc[4]],T[sc[5]],sc[0]);
      m.round=(i/4|0)+1;m.slot=i;m.court=sc[1];m.time=sc[2];m.tend=sc[3];m.code='曜請'+(i+1);
      return m;
    });
    const rank=rankGroup(T,ms);rank.forEach((t,i)=>{t.seedRank=i+1;t.tier='invite';});
    return {teams:T,rank,matches:ms,schedule:INVITE_SCHEDULE};
  }

  // ---- 108 隊統一清單（查詢頁 / 未來全站戰績卡共用真相）----
  function buildAllTeams(live){
    const tn=buildTournament(live);
    const inv=buildInvitational();
    const out=[];
    function push(t,track,groupLabel){
      // tier===null＝資格賽該組尚未完賽，分級待定（賽前的正常狀態）
      const tm=t.tier==='invite'?{name:'曜請',en:'INVITATIONAL',col:'#ffc24b'}
              :(TIER_META[t.tier]||{name:'待定',en:'PENDING',col:'#5b7089',base:0});
      out.push({
        tid:t.tid,label:t.label,players:t.players||['—','—'],
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
    rankGroup,buildTournament,buildInvitational,buildAllTeams,
    setLive,hasLive,liveResult,INVITE_SCHEDULE,QUAL_SCHEDULE,GROUP_MAP,
  };
})(typeof window!=='undefined'?window:this);
