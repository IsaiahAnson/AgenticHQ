(() => {
  'use strict';
  const TAU=Math.PI*2,DAY=86400000,keys=['A','X','R','M','S'];
  const names={A:'Applications',X:'Automations',R:'Routines',M:'Memory',S:'Skills'};
  const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
  const smooth=t=>t*t*t*(t*(t*6-15)+10);
  const hash=s=>{let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return(h>>>0)/4294967296};
  // Spots a Rings caption may take around its anchor, nearest first: sideways counts a bit more than up or down, and up wins a tie.
  const CAPTION_SPOTS=(()=>{const out=[];for(let dx=-72;dx<=72;dx+=8)for(let dy=-68;dy<=68;dy+=4)out.push([dx,dy,Math.hypot(dx*1.4,dy)+(dy>0?1:0)]);return out.sort((a,b)=>a[2]-b[2])})();
  const $=id=>document.getElementById(id),RMQ=matchMedia('(prefers-reduced-motion:reduce)');let reduced=RMQ.matches;RMQ.addEventListener?.('change',e=>{reduced=e.matches;try{draw(true)}catch{}});
  // motion layer (2026-10-28): hover grows a node, a new selection sends one pulse, the tooltip waits a beat before it shows
  let hoverNode=null,hoverAt=-1e9,selNode=null,selAt=-1e9,tipFor=null,tipT=0,scrubRaf=0,legendDim=false;
  let S,canvas,ctx,mode='orbs',yaw=.27,pitch=-.42,zoom=1,pan={x:0,y:0};
  // speed pass: node sprites draw on a WebGL layer (port-gl.js) between this 2D canvas and a top 2D canvas
  // for labels and rings. baseCtx is the 2D canvas under it; GLR is null when WebGL2 is not available.
  let baseCtx=null,GLR=null,topCanvas=null,topCtx=null,shellCanvas=null,shellCtx=null,shellPending=false,glOff=false;
  const useGL=()=>!!(GLR&&GLR.ok&&!glOff);
  let motion=true,links=false,glow=false,labels=true,active=true,ringAngles={A:0,R:0,X:1.1},ringAxis={A:0,R:0,X:2.3},chromeTop=112,last=0,fileLabelAlpha=0;
  let mapGroups=null,mapCaptions=[],lastSig='',drawnFrames=0,motionSpeed=1,driftT=0,driftOff=0,timelineVersion=0,changing=null,unfold=null,points=new Map(),homes=new Map(),signature='',styleKey='';
  let timePositions=new Map(),timeLanes=[],timeTicks=[],timeScale=1,timePan={x:0,y:0};
  let timelineDirty=true,timelineBounds=null,timelineLayout=null,focusMove=null,drag=null,timelineExpanded=false,timelineHistoryLoaded=false;
  let timeOffset=0;try{timeOffset=Math.max(0,+localStorage.getItem('agentic-hq-timeline-offset')||0)}catch{}
  const sprites=new Map();let spriteGen=0,iconsRebuilt=0;let memorySectors=[],reveal=null,iconsDirty=false;addEventListener('brain-icons-ready',()=>{iconsDirty=true;warm()});
  // Node size, cached per node until a size setting, its file count or its stage state changes.
  // The fields carry a _qr prefix because _core.js writes n._rv (ring visibility) during map layouts;
  // sharing that name set every node's size to 1 on the 2D map and in 3D after it (fixed 16 Oct).
  let radKey='';const rad=n=>{if(n._qrK===radKey&&n._qrF===n.files&&n._qrO===n._offstage)return n._qrV;n._qrK=radKey;n._qrF=n.files;n._qrO=n._offstage;return n._qrV=S.radiusOf(n)};
  // While the brain waits hidden, draw it once in the background so every node image is built and
  // frozen before the first click; opening then never stalls on that work.
  function warm(){clearTimeout(warm.t);warm.t=setTimeout(()=>{if(!S||active)return;draw(true);if(iconsDirty)warm()},300)}
  const mapLayouts=new Map(Object.entries(new URLSearchParams(location.search).has('precompute')?{}:window.BRAIN_MAP_LAYOUTS||{}).map(([key,positions])=>[key,new Map(positions.map(([id,x,y])=>[id,{x,y}]))]));
  function layer(n){if(n.type==='router')return'M';if(n.layer==='X')return'X';return n.layer==='S'?'S':n.type==='app'||n.layer==='A'?'A':n.type==='routine'||n.layer==='R'?'R':'M'}
  function shown(n){return !n._hidden&&!n._offstage&&S.pass(n)}
  function area(){return{left:28,top:chromeTop+18,w:S.W-56,h:S.H-chromeTop-48}}
  function frame(){const a=area();return{cx:S.W/2+pan.x,cy:a.top+a.h*.51+pan.y,r:Math.min(a.w*.41,a.h*.43)*zoom}}
  function radius(k){const target={A:1,X:.905,R:.81,M:.59,S:.19}[k],start={A:1,X:.8,R:.70,M:.46,S:.12}[k];return unfold&&!zoomOn()?start+(target-start)*smooth(unfold.progress):target}
  function rotate(p){const cy=Math.cos(yaw),sy=Math.sin(yaw),cx=Math.cos(pitch),sx=Math.sin(pitch),x=p.x*cy+p.z*sy,z=-p.x*sy+p.z*cy;return{x,y:p.y*cx-z*sx,z:p.y*sx+z*cx}}
  function project(p,f=frame()){const perspective=1/(1-p.z/Math.max(900,f.r*4.2));return{x:f.cx+p.x*perspective,y:f.cy-p.y*perspective,z:p.z,scale:perspective}}
  // Each ring spins in its own plane (ringAngles) and that plane precesses around a second axis
  // (ringAxis): the tilt keeps a gentle, breathing angle while its direction turns, so the rings
  // never flip vertical through the globe.
  function ringVector(k,angle){const base=k==='A'?.22:k==='X'?.62:-.2,phi=ringAxis[k],tilt=base*(1+.4*Math.sin(phi*1.7)),a=angle+ringAngles[k],x0=Math.cos(a),z0=Math.sin(a),y=Math.sin(tilt)*z0,z1=Math.cos(tilt)*z0,c=Math.cos(phi),s=Math.sin(phi);return{x:x0*c+z1*s,y,z:-x0*s+z1*c}}
  function settle(){
    if(S.visible===lastVisible)return;lastVisible=S.visible;const sig=S.visible.map(n=>n.id).join('|');if(sig===signature)return;signature=sig;timelineDirty=true;
    for(const k of keys){
      const pool=S.visible.filter(n=>layer(n)===k&&n.type!=='router'&&!n._hidden).sort((a,b)=>a.id.localeCompare(b.id));
      if(k==='M'){
        const groups=S.departments.map(d=>({dept:d.key,nodes:pool.filter(n=>n.dept===d.key)}));
        const other=pool.filter(n=>!S.departments.some(d=>d.key===n.dept));if(other.length)groups.push({dept:'workspace',nodes:other});
        memorySectors=[];const weights=groups.map(g=>Math.max(.035,g.nodes.length/pool.length)),totalWeight=weights.reduce((sum,w)=>sum+w,0);let sectorStart=-Math.PI;
        for(let sector=0;sector<groups.length;sector++){
          const g=groups[sector],sectorWidth=TAU*weights[sector]/totalWeight,start=sectorStart+.025,span=sectorWidth-.05;memorySectors.push({key:g.dept,start:sectorStart,end:sectorStart+sectorWidth,color:S.deptColor[g.dept]||'#aaa'});sectorStart+=sectorWidth;
          for(let i=0;i<g.nodes.length;i++){
            const n=g.nodes[i];if(homes.has(n.id))continue;
            const y=1-2*(i+.5)/g.nodes.length,a=start+((i*.618033988749895)%1)*span,r=Math.sqrt(1-y*y);
            homes.set(n.id,{x:Math.cos(a)*r,y,z:Math.sin(a)*r,sector:g.dept,longitude:a,ring:false});
          }
        }
      }else if(k==='A'||k==='R'||k==='X'){
        for(let i=0;i<pool.length;i++)if(!homes.has(pool[i].id))homes.set(pool[i].id,{angle:i/pool.length*TAU,ring:true,layer:k});
      }else{
        for(let i=0;i<pool.length;i++)if(!homes.has(pool[i].id)){
          const y=1-2*(i+.5)/pool.length,a=i*Math.PI*(3-Math.sqrt(5)),r=Math.sqrt(1-y*y);
          homes.set(pool[i].id,{x:Math.cos(a)*r,y,z:Math.sin(a)*r,ring:false});
        }
      }
    }
  }
  function orbPoint(n){const f=frame(),size=.55*zoom**.38;if(n.type==='router')return{x:f.cx,y:f.cy,z:0,scale:size};const h=homes.get(n.id)||{x:0,y:0,z:0},k=layer(n),v=h.ring?ringVector(k,h.angle):h,r=f.r*radius(k),p=project(rotate({x:v.x*r,y:v.y*r,z:v.z*r}),f);p.scale*=size;return p}
  function mapPoint(n){return{x:n.x*S.cam.k+S.cam.x,y:n.y*S.cam.k+S.cam.y,z:0,scale:S.cam.k}}
  function timePoint(n){const p=timePositions.get(n.id);return p?{...p,x:S.W/2+(p.x-S.W/2)*timeScale+timePan.x,y:S.H/2+(p.y-S.H/2)*timeScale+timePan.y,scale:p.scale*timeScale}:null}
  function timelineAnchor(n){const lane=timeLanes.find(l=>l.key===layer(n));return{x:S.W/2+((timelineBounds?.left||134)-34-S.W/2)*timeScale+timePan.x,y:S.H/2+((lane?.bottom||S.H/2)-S.H/2)*timeScale+timePan.y,z:0,scale:.35*timeScale}}
  function target(n){return mode==='map'?mapPoint(n):mode==='timeline'?timePoint(n):orbPoint(n)}
  function prepareMap(){const saved=mapLayouts.get(S.st.layout);if(saved)for(const n of S.visible){const p=saved.get(n.id);if(p){n.x=p.x;n.y=p.y;n.vx=n.vy=0}}S.fly=null;BrainCore.setLayout(S.st.layout,true);if(saved&&S.sim&&S.st.layout!=='rings')S.sim.alpha(.04);if(S.st.layout==='rings'){S.rTrans=null;BrainCore.placeRings()}fitMap();capIn=0;capPin=S.sim;capHeat=S.sim?S.sim.alpha():0}
  function fitMap(){const a=area(),ns=S.visible.filter(shown),extent=Math.max(200,...ns.map(n=>Math.hypot(n.x,n.y)+S.radiusOf(n)));S.fly=null;S.cam={k:Math.min(a.w/(2*extent+80),a.h/(2*extent+80)),x:S.W/2,y:a.top+a.h*.51}}
  function buildTimeline(){if(!timelineDirty)return;timelineDirty=false;timelineVersion++;timelineLayout=BrainTimeline.build({S,shown,layer,top:chromeTop,monthOffset:timeOffset});if(timelineHistoryLoaded)timeOffset=timelineLayout.monthOffset;timePositions=timelineLayout.positions;timeLanes=timelineLayout.lanes;timeTicks=timelineLayout.ticks;timelineBounds=timelineLayout.bounds;const slider=$('timeline-range');if(slider){slider.max=timelineLayout.maxOffset;slider.value=timelineLayout.monthOffset;slider.disabled=!timelineLayout.maxOffset;$('timeline-range-label').textContent=timelineLayout.monthOffset?timelineLayout.months[0].short+' '+timelineLayout.months[0].year+' – '+timelineLayout.months.at(-1).short+' '+timelineLayout.months.at(-1).year:'Latest 3 months'}}
  function setView(next,animate=true){if(!['orbs','map','timeline'].includes(next))return;if(next===mode){if(!animate){changing=null;draw(true)}return}const from=new Map(points),previous=mode;mode=next;focusMove=null;S.sim?.stop();S.fly=null;if(next==='map')prepareMap();if(next==='timeline'){timelineDirty=true;buildTimeline();if(!timelineExpanded){timelineExpanded=true;BrainCore.expandAll().then(()=>{timelineHistoryLoaded=true;timelineDirty=true;if(mode==='timeline'){buildTimeline();draw(true)}})}}changing=animate?{from,previous,start:performance.now(),duration:reduced?0:1000}:null;BrainCore.select(null);if(!animate)draw(true);postState()}
  function setLayout(layout){if(!['force','circle','hex','rings'].includes(layout))return;const from=new Map(points);S.st.layout=layout;prepareMap();if(mode!=='map')setView('map');else changing={from,previous:'map',start:performance.now(),duration:reduced?0:850};postState()}
  function pathLine(points,color,alpha=.13,width=.65){ctx.globalAlpha=alpha;ctx.strokeStyle=color;ctx.lineWidth=width;ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.stroke()}
  function drawShells(alpha,labelsOnly=false){
    if(alpha<.002)return;const f=frame();ctx.save();let outer=0;const placed=[];
    if(labels&&labelsOnly)for(const k of ['A','X','R']){if(S.st.layers[k]===false)continue;const r=f.r*radius(k);for(let i=0;i<72;i++){const v=ringVector(k,i/72*TAU),q=project(rotate({x:v.x*r,y:v.y*r,z:v.z*r}));outer=Math.max(outer,Math.hypot(q.x-f.cx,q.y-f.cy))}}
    for(const k of keys){if(S.st.layers[k]===false)continue;const r=f.r*radius(k),color=S.st.quietMono?'#cfcfc8':S.layerColor[k];
      if(!labelsOnly&&(k==='A'||k==='R'||k==='X')){
        const line=Array.from({length:121},(_,i)=>{const v=ringVector(k,i/120*TAU);return project(rotate({x:v.x*r,y:v.y*r,z:v.z*r}))});pathLine(line,color,alpha*.19,.65);
      }else if(!labelsOnly&&k==='M'){
        drawShellLayer(memoryShell(alpha),'back');
      }else if(!labelsOnly){
        for(const lat of [-.67,0,.67])pathLine(Array.from({length:91},(_,i)=>{const angle=i/90*TAU,rr=r*Math.sqrt(1-lat*lat);return project(rotate({x:Math.cos(angle)*rr,y:lat*r,z:Math.sin(angle)*rr}))}),color,alpha*.07,.6);
        for(let mer=0;mer<5;mer++)pathLine(Array.from({length:91},(_,i)=>{const angle=i/90*TAU,m=mer*Math.PI/5;return project(rotate({x:Math.cos(angle)*Math.cos(m)*r,y:Math.sin(angle)*r,z:Math.cos(angle)*Math.sin(m)*r}))}),color,alpha*.065,.6);
      }
      if(!labels||!labelsOnly)continue;
      const size=clamp(11*zoom**.2,10,18),text=names[k].toUpperCase();ctx.fillStyle=color;ctx.font=`600 ${size}px Segoe UI Variable,Segoe UI,sans-serif`;ctx.letterSpacing='2.4px';ctx.lineJoin='round';
      if(k==='A'||k==='X'||k==='R'){
        // ring names sit just outside the orb, level with the ring's widest point on screen, so they never cross its nodes
        const want=k==='A'?{x:1,y:0}:k==='R'?{x:-1,y:0}:{x:0,y:1};let far=null,best=-Infinity;
        for(let i=0;i<72;i++){const v=ringVector(k,i/72*TAU),q=project(rotate({x:v.x*r,y:v.y*r,z:v.z*r})),dx=q.x-f.cx,dy=q.y-f.cy,d=Math.max(1,Math.hypot(dx,dy)),score=d+.12*f.r*(dx*want.x+dy*want.y)/d;if(score>best){best=score;far={q,ux:dx/d,uy:dy/d}}}
        const w=ctx.measureText(text).width,align=far.ux>.3?'left':far.ux<-.3?'right':'center';let dist=outer+30,x=0,y=0,box=null;
        for(let t=0;t<5;t++){x=f.cx+far.ux*dist;y=f.cy+far.uy*dist;const base=y+(far.uy>.3?size*.8:far.uy<-.3?0:size*.35),x0=align==='left'?x:align==='right'?x-w:x-w/2;box={x0,y0:base-size,x1:x0+w,y1:base+4,base};if(!placed.some(b=>b.x0<box.x1&&box.x0<b.x1&&b.y0<box.y1&&box.y0<b.y1))break;dist+=size+8}
        placed.push(box);ctx.globalAlpha=alpha*.3;ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(far.q.x+far.ux*8,far.q.y+far.uy*8);ctx.lineTo(x-far.ux*5,y-far.uy*5);ctx.stroke();
        ctx.globalAlpha=alpha*.9;ctx.textAlign=align;ctx.strokeStyle='#000';ctx.lineWidth=4;ctx.strokeText(text,x,box.base);ctx.fillText(text,x,box.base);ctx.letterSpacing='0px';continue;
      }
      const p=k==='M'?{x:f.cx,y:f.cy-r*1.04-8,z:1,scale:1}:project(rotate({x:0,y:-(r+16),z:0}));ctx.globalAlpha=alpha*(p.z<0?.6:.9);ctx.textAlign='center';ctx.strokeStyle='#000';ctx.lineWidth=4;ctx.strokeText(text,p.x,p.y+(k==='S'?12:-6));ctx.fillText(text,p.x,p.y+(k==='S'?12:-6));ctx.letterSpacing='0px';
    }
    ctx.restore();
  }
  // Memory shell: one translucent, lit patch per department longitude sector, with
  // neutral grey meridians on the sector edges. Back faces sit behind every node; front
  // faces are drawn between the inner nodes and the nodes that sit in front of the shell.
  let currentShell=null;
  function memoryShell(alpha){
    if(alpha<.002||S.st.layers.M===false||!memorySectors.length)return currentShell=null;
    // Each department is one flat, faint wash over the front of the globe only. No lighting, so no
    // lit facets at any angle, and the front
    // quads of a sector merge into one path, so there are no seams or overlapping back layers.
    const f=frame(),r=f.r*radius('M'),back=new Map(),front=new Map(),lines=[],LAT=18,mono=S.st.quietMono;
    const unit=(lon,lat)=>({x:Math.cos(lat)*Math.cos(lon),y:Math.sin(lat),z:Math.cos(lat)*Math.sin(lon)});
    const at=u=>{const v=rotate(u);return{p:project({x:v.x*r,y:v.y*r,z:v.z*r},f),z:v.z}};
    for(const s of memorySectors){
      const span=s.end-s.start,LON=Math.max(3,Math.ceil(span/(TAU/48))),grid=[],path=new Path2D();
      for(let i=0;i<=LON;i++){const lon=s.start+span*i/LON,col=[];for(let j=0;j<=LAT;j++)col.push(at(unit(lon,-Math.PI/2+Math.PI*j/LAT)));grid.push(col)}
      for(let i=0;i<LON;i++)for(let j=0;j<LAT;j++){
        const a=grid[i][j],b=grid[i+1][j],c=grid[i+1][j+1],d=grid[i][j+1];if(a.z+b.z+c.z+d.z<0)continue;
        path.moveTo(a.p.x,a.p.y);path.lineTo(b.p.x,b.p.y);path.lineTo(c.p.x,c.p.y);path.lineTo(d.p.x,d.p.y);path.closePath();
      }
      front.set(s.key,{path,fill:mono?'#bdbdb6':s.color,alpha:.05*alpha});
      lines.push(Array.from({length:73},(_,j)=>at(unit(s.start,-Math.PI/2+Math.PI*j/72))));
    }
    return currentShell={back,front,lines,alpha,split:.2*r};
  }
  function drawShellLayer(shell,which){
    if(!shell)return;ctx.save();
    for(const g of shell[which].values()){ctx.globalAlpha=g.alpha;ctx.fillStyle=g.fill;ctx.fill(g.path)}
    ctx.strokeStyle='#a4a4a0';ctx.lineWidth=which==='back'?.7:1;ctx.lineCap='round';
    for(const line of shell.lines){ctx.globalAlpha=shell.alpha*(which==='back'?.16:.46);ctx.beginPath();let on=false;for(const pt of line){if(which==='back'?pt.z<0:pt.z>=0){on?ctx.lineTo(pt.p.x,pt.p.y):ctx.moveTo(pt.p.x,pt.p.y);on=true}else on=false}ctx.stroke()}
    ctx.restore();
  }
  function applyUnfold(){if(!unfold)return;if(zoomOn()){const z=zoomAt(unfold.progress);ctx.translate(z.cx,z.cy);ctx.scale(z.s,z.s);ctx.translate(-z.f.cx,-z.f.cy);return}const progress=smooth(unfold.progress),f=frame(),src=unfold.source||{x:S.W/2,y:S.H*.45},scale=.82+.18*progress;ctx.translate(f.cx+(src.x-f.cx)*(1-progress),f.cy+(src.y-f.cy)*(1-progress));ctx.scale(scale,scale);ctx.translate(-f.cx,-f.cy)}
  // Zoomed globe file names: front-most first, skipping any that would overlap one already placed.
  function drawLabelQueue(queue){if(!queue.length)return;queue.sort((a,b)=>b.z-a.z);const cells=new Set(),CW=36,CH=14;let placed=0;ctx.save();ctx.font='400 11px Segoe UI Variable,Segoe UI,sans-serif';ctx.textAlign='center';ctx.fillStyle='#dedede';
    for(const l of queue){if(placed>=160)break;if(l.x<0||l.x>S.W||l.y<chromeTop||l.y>S.H)continue;const w=l.text.length*5.6+8,x0=Math.floor((l.x-w/2)/CW),x1=Math.floor((l.x+w/2)/CW),row=Math.floor((l.y-9)/CH),keys=[];let free=true;
      for(let cx=x0;cx<=x1&&free;cx++)for(const ry of [row,row+1]){const k=cx+':'+ry;if(cells.has(k)){free=false;break}keys.push(k)}
      if(!free)continue;for(const k of keys)cells.add(k);ctx.globalAlpha=l.a;ctx.fillText(l.text,l.x,l.y);placed++}
    ctx.restore()}
  function timeTip(n){const when=n.mtime>0?HQTime.dateTime(n.mtime,{year:true}):null,basis=n.dateBasis||(n.type==='router'?'Latest context file edit':'Last edited');const pos=timePositions.get(n.id);let pile='';
    // a crowded day stacks its icons tightly, so the tooltip names everything in that day's pile
    if(pos?.icon&&pos.day!=='older'){const same=[...timePositions].filter(([,q])=>q.icon&&q.lane===pos.lane&&q.day===pos.day).map(([id])=>S.byId.get(id)?.label).filter(Boolean);if(same.length>3)pile='<div class="tmut" style="margin-top:6px">'+same.length+' on this day: '+same.slice(0,8).map(s=>String(s).replace(/[<>&]/g,'')).join(', ')+(same.length>8?' and '+(same.length-8)+' more':'')+'</div>'}
    return '<div class="tmut" style="margin-top:6px">'+(when?basis+': '+when:basis+' · shown in Older')+'</div>'+pile}
  function drawTimeline(alpha){BrainTimeline.draw(ctx,{layout:timelineLayout,S,scale:timeScale,pan:timePan,alpha})}
  // Captions keep clear of every drawn node: each takes the nearest clear spot around its anchor, and on Rings a ring's
  // header also stays between the headers of the rings outside and inside it, so they still read in ring order. With
  // nothing clear nearby (a packed Circle or Hex) it heads straight out from the middle of the map to the first clear
  // spot; only when that runs off screen does it stack upward as before. Force, Circle and Hex nodes drift while the
  // layout settles, so there a caption holds its spot (capSpots) while that spot stays clear, and when a node blocks it
  // moves to the clear spot nearest the one it held, with 5 px to spare where it can (room), so the next few frames of
  // drift don't block it again at once. One that had to head out past its search box comes back in only while it fades
  // in, to a spot nearer its anchor that has twice that room.
  const capSpots=new Map(),capTrim=new Set(),capEase=new Map();let capLayout='',capIn=1,capPin=null,capHeat=0;
  // How far the captions have faded in: over the glide's second half, when the nodes are mostly in, and on Force, Circle
  // and Hex not before their sim has cooled from alpha .35 to .2. Before that the clusters are still forming and nodes
  // sweep through the captions, which hopped 50 to 100 times as they faded in. The sim ticks once a screen frame, so it
  // cools inside the glide at 165 or 240 Hz and 0.8 to 1.2 s after the switch at 60 Hz. Once in they stay in until the
  // next layout or view switch (prepareMap), so a drag or a filter that reheats the sim doesn't hide them. capPin is the
  // sim that switch started, while it cools untouched (only then do Circle and Hex captions hold their place on the
  // screen, see caption()): a drag (alphaTarget), a reheat (its alpha rising), a rebuild (refreshLayout makes a new sim)
  // or its coming to rest ends it.
  function capAlpha(t){const glide=changing?smooth(clamp(t*2-1)):1;if(S.st.layout==='rings')return glide;capIn=Math.max(capIn,S.sim?smooth(clamp((.35-S.sim.alpha())/.15)):1);
    if(capPin){const a=capPin.alpha();if(S.sim!==capPin||capPin.alphaTarget()>0||a>capHeat+1e-4||a<capPin.alphaMin())capPin=null;else capHeat=a}return glide*capIn}
  function drawMapLabels(alpha){if(!labels)return;ctx.save();ctx.globalAlpha=alpha;ctx.textAlign='center';const used=[],heads=[],onScreen=(x,y)=>x>=30&&x<=S.W-30&&y>=chromeTop+8&&y<=S.H-28,now=performance.now();mapCaptions=[];
    // alt: a second anchor, tried when nothing near the first is clear (a department's label just outside its own files)
    function caption(text,x,y,color,size=12,header=false,alt=null){const anchors=[{x,y},alt].map(a=>a&&onScreen(a.x,a.y)?a:null);if(!anchors[0]&&!anchors[1])return;
      ctx.font=(header?'600 ':'500 ')+size+'px Segoe UI Variable,Segoe UI,sans-serif';ctx.letterSpacing=header?'2.4px':'0px';
      const w=header?text.length*size*.85+20:text.length*size*.55+16,hw=ctx.measureText(text).width/2+3,ay=y,room=rings?0:5,hit=(cx,cy,pad=0)=>used.some(p=>Math.abs(p.x-cx)<(p.w+w)/2+pad&&Math.abs(p.y-cy)<size+6+pad),
        inOrder=cy=>!rings||!header||heads.every(h=>h.ay<ay?cy>h.y:h.ay>ay?cy<h.y:true),
        // the text box (its 5 px outline included) against each node's disc and the captions already placed, grown by pad px
        clear=(cx,cy,near=discs,pad=0)=>onScreen(cx,cy)&&inOrder(cy)&&!hit(cx,cy,pad)&&!near.some(d=>{const nx=Math.max(cx-hw,Math.min(d.x,cx+hw))-d.x,ny=Math.max(cy-size-1,Math.min(d.y,cy+4))-d.y,r=d.r+pad;return nx*nx+ny*ny<r*r}),
        nearOf=b=>discs.filter(d=>Math.abs(d.x-b.x)<hw+72+room*2+d.r&&Math.abs(d.y-b.y)<size+69+room*2+d.r),
        // the clear spot nearest to (hx,hy) around either anchor, and with own also around (hx,hy) itself (a held spot's
        // own neighbourhood, kept as an offset from anchor own), trying each pad in turn; max skips spots that sit as far
        // from their anchor as that (the CAPTION_SPOTS order) or farther
        nearest=(hx,hy,pads,max=Infinity,own=-1)=>{for(const pad of pads){let best=Infinity,s=null;for(let i=0;i<3;i++){const b=i<2?anchors[i]:anchors[own]&&{x:hx,y:hy};if(!b)continue;const near=nearOf(b);
          for(const [dx,dy,far] of CAPTION_SPOTS){const c=Math.hypot((b.x+dx-hx)*1.4,b.y+dy-hy);if(c<best&&(i===2||far<max)&&clear(b.x+dx,b.y+dy,near,pad)){best=c;s=i<2?{a:i,dx,dy}:{a:own,dx:hx+dx-anchors[own].x,dy:hy+dy-anchors[own].y}}}}if(s)return s}return null};
      // A held spot only has to stay 2 px off each node (pad -1). On Circle and Hex, while the sim a switch started cools
      // (capPin), a caption that shows (alpha .25 or more) holds its place on the screen, not its offset from its anchor: a
      // layer's top slides as its nodes settle, and there the headers' anchors sit within a few px of each other, so
      // following them ran one header into the next and sent them hopping 40 to 90 px. A pan carries it along; a zoom, a
      // drag or a filter (anything that moves the layers for good) puts it back on its offset. A spot in its search box
      // stays while clear, else takes the clear spot nearest it, around either anchor or around itself, room first. One
      // that had to head out past its box also stays while clear, and moves to the clear spot nearest it when blocked; only
      // while it is still fading in does it come back in, to a spot nearer its anchor with twice that room.
      let spot=null,was=null;const kept=rings?null:capSpots.get(text);
      if(kept){const k=anchors[kept.a],pin=k&&still&&capPin&&alpha>=.25&&kept.k===S.cam.k,hx=pin?kept.x+S.cam.x-kept.cx:k?k.x+kept.dx:kept.x,hy=pin?kept.y+S.cam.y-kept.cy:k?k.y+kept.dy:kept.y;was=[hx,hy];
        if(k){const dx=hx-k.x,dy=hy-k.y,here={a:kept.a,dx,dy},held=clear(hx,hy,discs,-1),pads=new Set([room,0]),inBox=Math.abs(dx)<=72&&Math.abs(dy)<=68;
          spot=inBox?held?here:nearest(hx,hy,pads,Infinity,kept.a)
            :alpha<.25&&nearest(hx,hy,[room*2],Math.hypot(dx*1.4,dy)+(dy>0?1:0))||(held?here:nearest(hx,hy,pads,Infinity,kept.a));
          // nothing clear around it either: straight out from the middle of the map, past where it was, so it stays on its
          // side of its anchor (heading out from the anchor again could take a ray to its other side, a 568 px hop on Circle)
          if(!spot){const ux=hx-S.cam.x,uy=hy-S.cam.y,l=Math.hypot(ux,uy),sx=l>1?ux/l:0,sy=l>1?uy/l:-1;
            for(const pad of pads)for(let t=4;!spot&&onScreen(hx+sx*t,hy+sy*t);t+=4)if(clear(hx+sx*t,hy+sy*t,discs,pad))spot={a:kept.a,dx:dx+sx*t,dy:dy+sy*t}}}
        else spot=nearest(hx,hy,new Set([room,0]))}
      for(let i=0;!spot&&i<2;i++){const b=anchors[i];if(!b)continue;const near=nearOf(b);for(const pad of new Set([room,0])){const s=CAPTION_SPOTS.find(([dx,dy])=>clear(b.x+dx,b.y+dy,near,pad));if(s){spot={a:i,dx:s[0],dy:s[1]};break}}}
      if(!spot){const a=anchors[1]?1:0,b=anchors[a],ux=b.x-S.cam.x,uy=b.y-S.cam.y,l=Math.hypot(ux,uy),sx=l>1?ux/l:0,sy=l>1?uy/l:-1;
        for(const pad of new Set([room,0]))for(let t=4;!spot&&onScreen(b.x+sx*t,b.y+sy*t);t+=4)if(clear(b.x+sx*t,b.y+sy*t,discs,pad))spot={a,dx:sx*t,dy:sy*t}}
      const ai=spot?spot.a:anchors[0]?0:1,at=anchors[ai];x=at.x;y=at.y;
      if(spot){x+=spot.dx;y+=spot.dy;if(!rings)capSpots.set(text,{a:spot.a,dx:spot.dx,dy:spot.dy,x,y,k:S.cam.k,cx:S.cam.x,cy:S.cam.y})}else{capSpots.delete(text);for(let i=0;i<10&&hit(x,y);i++)y-=size+6}
      // A move of up to 24 px (three CAPTION_SPOTS steps across) takes about 100 ms, not one frame (capEase): the gap
      // from where the caption was drawn (carried along by its old spot, or with no spot held, by its anchor) to its
      // new spot shrinks by e^(-30t) over t seconds, 95% gone at 100 ms at any frame rate, so a node that pushes it on
      // again before it gets there doesn't stop and restart it. Where it is drawn keeps a held spot's clearance (2 px
      // off each node and the captions placed before it): eased, a caption a node had pushed aside lagged back over
      // that node, so then it is drawn only the part of the gap that is clear, and with none, at its spot. A longer move
      // still jumps: eased, it glided across the captions in its way. Only for one drawn in the last 100 ms, and not on
      // Rings. Its spot, and what the captions after it keep clear of, is where it is heading.
      let rx=0,ry=0;if(!rings){const e=capEase.get(text),c=e&&anchors[e.a],f=was||e&&(c?[e.x+c.x-e.ax,e.y+c.y-e.ay]:[e.x,e.y]);
        if(e&&now-e.t<100&&Math.hypot(f[0]-x,f[1]-y)<=24){const q=Math.exp(-30*(now-e.t)/1000);rx=(e.rx+f[0]-x)*q;ry=(e.ry+f[1]-y)*q;
          if(Math.hypot(rx,ry)<.5)rx=ry=0;else if(!clear(x+rx,y+ry,discs,-1)){let lo=0,hi=1;for(let i=0;i<5;i++){const m=(lo+hi)/2;if(clear(x+rx*m,y+ry*m,discs,-1))lo=m;else hi=m}rx*=lo;ry*=lo}}
        capEase.set(text,{x,y,a:ai,ax:at.x,ay:at.y,rx,ry,t:now})}
      if(header)heads.push({ay,y});used.push({x,y,w});x+=rx;y+=ry;
      let a=alpha;if(live){let gap=Infinity;for(const d of live){const ox=Math.max(x-hw-d.x,0,d.x-x-hw),oy=Math.max(y-size-1-d.y,0,d.y-y-4);gap=Math.min(gap,(ox||oy?Math.hypot(ox,oy):-Math.min(d.x-x+hw,x+hw-d.x,d.y-y+size+1,y+4-d.y))-d.renderRadius)}a*=.2+.8*smooth(clamp((gap+6)/8))}
      mapCaptions.push({text,x,y,w,size,ax:at.x,ay:at.y,alpha:a});ctx.globalAlpha=a;ctx.strokeStyle='#000';ctx.lineWidth=5;ctx.lineJoin='round';ctx.strokeText(text,x,y);ctx.fillStyle=color;ctx.fillText(text,x,y);ctx.globalAlpha=alpha;ctx.letterSpacing='0px'}
    const rings=S.st.layout==='rings',still=S.st.layout==='circle'||S.st.layout==='hex';let G=mapGroups,drawn=points;if(!G){ctx.restore();return}
    // While the nodes glide in (a layout or view switch) the captions sit where the nodes are heading, not where they are
    // mid-glide: placed against the gliding nodes, they hopped to a new spot nearly every frame. The glide ends on those
    // same spots, so nothing jumps when it does. On Rings that is where the nodes land; Force, Circle and Hex nodes keep
    // moving with their sim, so there the captions also wait for it to cool (capAlpha).
    if(changing){drawn=new Map([...points.keys()].map(id=>{const n=S.byId.get(id),p=mapPoint(n);if(p.x>=-100&&p.x<=S.W+100&&p.y>=-100&&p.y<=S.H+100)p.renderRadius=rad(n)*p.scale;return[id,p]}));G=buildMapGroups([...drawn].map(([id,p])=>({n:S.byId.get(id),p})))}
    if(capLayout!==S.st.layout){capSpots.clear();capTrim.clear();capEase.clear();capLayout=S.st.layout}if(G.router){used.push({x:G.router.p.x,y:G.router.p.y,w:44});used.push({x:G.router.p.x,y:G.router.p.y+Math.max(17,G.router.r*G.router.p.scale)+16,w:76})}
    const discs=[...drawn.values()].filter(p=>p.renderRadius>0&&(p.alpha??1)>.05).map(p=>({x:p.x,y:p.y,r:p.renderRadius+3}));
    // The nodes still pass under the captions on their way in (the captions sit clear of where they are heading), so while
    // the glide runs a caption dims as one goes under it: from 2 px off its text box to a fifth at 6 px in. A caption's
    // spot keeps 2 px clear of where each node is heading, so it is back to full as the glide ends.
    const live=changing?[...points.values()].filter(p=>p.renderRadius>0&&(p.alpha??1)>.05):null;
    // Layer headers sit on top of their own ring or cluster, uppercase like the original band headers.
    const idOf=new Map();if(S.st.layout==='force')for(const [id,p] of drawn)idOf.set(p,id);
    for(const k of keys){if(S.st.layers[k]===false)continue;const ps=G.layer[k];if(!ps.length)continue;let x,y;
      if(rings){x=S.cam.x;y=S.cam.y-G.layerOuter[k]*S.cam.k-17}
      else{let pts=ps;
        // Force: a few nodes pulled far out by their links (an app used by many routines) no longer drag the header away from
        // its own cluster. A node is left out past 2.4x the median distance and taken back under 2x (capTrim, by node id), so
        // one hovering near the line while the layout settles can't flip the header back and forth between frames.
        if(S.st.layout==='force'&&ps.length>4){const cx=ps.reduce((a,p)=>a+p.x,0)/ps.length,cy=ps.reduce((a,p)=>a+p.y,0)/ps.length,d=ps.map(p=>Math.hypot(p.x-cx,p.y-cy)),med=[...d].sort((a,b)=>a-b)[Math.floor(d.length/2)],
          ids=ps.map(p=>idOf.get(p)),out=ps.map((p,i)=>d[i]>med*(capTrim.has(ids[i])?2:2.4)),near=ps.filter((p,i)=>!out[i]);if(near.length>=ps.length/2){pts=near;ids.forEach((id,i)=>out[i]?capTrim.add(id):capTrim.delete(id))}}
        // the middle of its top tenth, each node weighted by how high it sits in it (not a hard cut), so a node crossing
        // into or out of that tenth while the layout settles slides the header a little instead of jumping it sideways
        let minY=Infinity,maxY=-Infinity;for(const p of pts){if(p.y<minY)minY=p.y;if(p.y>maxY)maxY=p.y}const band=Math.max((maxY-minY)*.1,1);let sx=0,c=0;for(const p of pts){const w=Math.max(0,1-(p.y-minY)/band);sx+=p.x*w;c+=w}x=sx/c;y=minY-16}
      caption(names[k].toUpperCase(),x,y,S.st.quietMono?'#ccc':S.layerColor[k],12,true)}
    // Department labels: on Rings just outside the department's own arc of files, at its middle (the band its hub sits in
    // has no room for a caption at 1920 wide, and one pushed off the hub lands beside another department's), or on the hub
    // when its files circle the whole ring or that spot is off screen. Elsewhere the middle of the department's own files,
    // with that spot just outside them as the second anchor.
    for(const d of S.departments){if(S.st.depts[d.key]===false||S.st.layers.M===false)continue;const ps=G.dept.get(d.key),p=rings?G.hubs.get(d.key):null;if(!ps?.length)continue;let sx=0,sy=0,ux=0,uy=0,far=0;for(const q of ps){sx+=q.x;sy+=q.y;const dx=q.x-S.cam.x,dy=q.y-S.cam.y,l=Math.hypot(dx,dy)||1;ux+=dx/l;uy+=dy/l;far=Math.max(far,l+(q.renderRadius||0))}let x=p?.x??sx/ps.length,y=(p?.y??sy/ps.length)-(p?17:0),alt=null;
      if(Math.hypot(ux,uy)>ps.length*.3){const a=Math.atan2(uy,ux),out=far+6+Math.abs(Math.cos(a))*(d.label.length*3.2+4)+Math.abs(Math.sin(a))*8,lx=S.cam.x+Math.cos(a)*out,ly=S.cam.y+Math.sin(a)*out+4;if(!rings)alt={x:lx,y:ly};else if(onScreen(lx,ly)){x=lx;y=ly}}
      caption(d.label,x,y,S.st.quietMono?'#bcbcb8':d.color,11,false,alt)}ctx.restore()}
  // One pass per frame over the drawn nodes gives the 2D guides and labels everything they need.
  function buildMapGroups(drawable){const G={layer:{A:[],X:[],R:[],M:[],S:[]},layerMax:{A:0,X:0,R:0,M:0,S:0},layerOuter:{A:0,X:0,R:0,M:0,S:0},allMax:0,dept:new Map(),hubs:new Map(),router:null};
    for(const e of drawable){const n=e.n,p=e.p,k=layer(n),h=Math.hypot(n.x,n.y);e.r=rad(n);if(h>G.layerMax[k])G.layerMax[k]=h;if(h+e.r>G.allMax)G.allMax=h+e.r;
      if(n.type==='router'){G.router={p,r:e.r};continue}if(n.type==='hub'){if(n.hubKind==='dept')G.hubs.set(n.dept,p);continue}
      if(h>G.layerOuter[k])G.layerOuter[k]=h;G.layer[k].push(p);if(k==='M'){let list=G.dept.get(n.dept);if(!list)G.dept.set(n.dept,list=[]);list.push(p)}}
    return G}
  function drawMap(alpha){if(!['circle','hex','rings'].includes(S.st.layout)||!mapGroups)return;ctx.save();ctx.globalAlpha=alpha*.14;ctx.strokeStyle='#cfcfc8';ctx.lineWidth=.6;
    if(S.st.layout==='rings'){for(const k of keys){if(S.st.layers[k]===false)continue;const r=mapGroups.layerMax[k]*S.cam.k;ctx.beginPath();ctx.arc(S.cam.x,S.cam.y,r,0,TAU);ctx.stroke()}}
    else{const r=mapGroups.allMax*S.cam.k;ctx.beginPath();if(S.st.layout==='circle')ctx.arc(S.cam.x,S.cam.y,r,0,TAU);else{for(let i=0;i<=6;i++){const a=i*TAU/6;const x=S.cam.x+Math.cos(a)*r,y=S.cam.y+Math.sin(a)*r;i?ctx.lineTo(x,y):ctx.moveTo(x,y)}}ctx.stroke()}ctx.restore()}
  // Links are batched into one path per kind (one stroke each), like the original engine,
  // so ~1,800 curves cost a handful of strokes per frame. The AGENTS md routes to the
  // department hubs are drawn solid in the department colour so the main structure reads.
  function curve(path,a,b,i){const bow=((i*2654435761)%2?1:-1)*(.07+(i*97%13)/13*.09);path.moveTo(a.x,a.y);path.quadraticCurveTo((a.x+b.x)/2-(b.y-a.y)*bow,(a.y+b.y)/2+(b.x-a.x)*bow,b.x,b.y)}
  const linkStyles={spoke:['#7fa6ff',.085,.5],link:['#7fa6ff',.1,.5],wire:['#50e3c2',.22,.6],sync:['#aab3da',.3,.7]};
  function drawEdges(alpha){if(mode==='timeline'||alpha<.002)return;const who=S.hover||S.sel,showLinks=links||mode==='map'&&S.st.layout==='force';if(!showLinks&&!who)return;const batch={},routes=[],hot=new Path2D();let hasHot=false;
    for(let i=0;i<S.drawLinks.length;i++){const edge=S.drawLinks[i],a=points.get(edge.s),b=points.get(edge.t);if(!a||!b)continue;if(Math.min(a.alpha??1,b.alpha??1)<.3)continue;
      if(who&&(edge.s===who.id||edge.t===who.id)){curve(hot,a,b,i);hasHot=true;continue}if(!showLinks)continue;
      if(edge.k==='route'){routes.push([edge,a,b,i]);continue}const k=linkStyles[edge.k]?edge.k:edge.k==='layer'?'spoke':'link';curve(batch[k]||(batch[k]=new Path2D()),a,b,i)}
    ctx.save();ctx.lineCap='round';const dim=S.focusSet?.35:1;
    for(const k in batch){const [c,a,w]=linkStyles[k];ctx.globalAlpha=alpha*a*dim*(mode==='orbs'?.75:1);ctx.strokeStyle=c;ctx.lineWidth=w;ctx.stroke(batch[k])}
    for(const [edge,a,b,i] of routes){const target=edge.tn.type==='router'?edge.sn:edge.tn,p=new Path2D();curve(p,a,b,i);ctx.globalAlpha=alpha*dim*(mode==='map'?.72:.42);ctx.strokeStyle=S.st.quietMono?'#d8d8d0':S.colorOf(target);ctx.lineWidth=mode==='map'?1.6:1.1;ctx.stroke(p)}
    if(hasHot){ctx.globalAlpha=alpha*.6;ctx.strokeStyle=S.colorOf(who);ctx.lineWidth=.8;ctx.stroke(hot)}ctx.restore()}
  // Each node keeps its last tile, so the frame loop skips the key string; file dots get tight tiles.
  function sprite(n,r){if(n._sg===spriteGen&&n._sr===r&&n._se===n.expanded&&n._sf===n.files)return n._sv;const v=spriteFor(n,r);n._sg=spriteGen;n._sr=r;n._se=n.expanded;n._sf=n.files;n._sv=v;return v}
  // Sprite atlas: every node tile is painted once onto a few shared 2048px canvases, so the GPU
  // draws ~1,800 nodes from one texture instead of switching between ~1,800 small ones.
  // speed: the ~1,650 small file/folder sprites get sheets of their own, apart from the large glowing app and
  // routine sprites. The draw goes back to front, so mixed sheets meant a sheet switch on most draws.
  // (4096 px sheets were tried: Chrome drew them far slower, 10 fps.)
  const ATLAS=2048;let atlases=[],shelves={};
  function atlasReset(){for(const a of atlases)a.bmp?.close?.();atlases=[];shelves={}}
  // Once a sheet stops changing it is frozen into an ImageBitmap, a GPU texture uploaded once.
  // Drawing straight from a 2048px canvas made Chrome re-upload it every frame (27 fps -> the cost).
  function freezeAtlases(){for(const a of atlases){if(a.bmp||a.frozen===a.ver||typeof createImageBitmap!=='function')continue;const v=a.frozen=a.ver;createImageBitmap(a.c).then(b=>{if(a.ver===v&&atlases.includes(a)){a.bmp=b;lastSig=''}else b.close()}).catch(()=>{})}}
  function atlasAlloc(size,group){let s=shelves[group];if(s&&s.x+size>ATLAS){s.x=0;s.y+=s.h;s.h=0}if(!s||s.y+size>ATLAS){const c=document.createElement('canvas');c.width=c.height=ATLAS;const a={c,ctx:c.getContext('2d'),bmp:null,ver:0,frozen:-1,i:atlases.length};atlases.push(a);s=shelves[group]={a,x:0,y:0,h:0}}const x=s.x,y=s.y;s.x+=size+2;s.h=Math.max(s.h,size+2);return{a:s.a,x,y}}
  // speed: sizes snap to quarter-pixel steps and the draw scales back to the exact size (at most 1/8 px off).
  // File sizes made ~1,300 one-off sprites over 15 sheets, and switching sheets between draws is what cost the frame.
  function spriteFor(n,rExact){const r=Math.max(.25,Math.round(rExact*4)/4),key=[n.type,n.layer,n.icon,n.appIcon,n.type==='app'||n.type==='routine'?n.id:'',n.sprite,n.expanded,n.files,r,S.colorOf(n),S.st.shapes,glow].join('|');if(sprites.has(key))return sprites.get(key);const half=Math.ceil(Math.max(n.type==='router'?68:r*(glow?4.2:2.5),n.type==='file'||n.type==='dir'?8:20)),size=half*4,{a,x,y}=atlasAlloc(size,n.type==='app'||n.type==='routine'?'big':'small'),c=a.ctx;
    c.save();c.beginPath();c.rect(x,y,size,size);c.clip();c.setTransform(2,0,0,2,x+half*2,y+half*2);S.skin.drawNode(c,{...n,x:0,y:0},r,true,false,S);if(n.type==='routine'){c.globalAlpha=1;c.fillStyle='#07080c';c.beginPath();c.arc(0,0,r*.8,0,TAU);c.fill();S.drawNodeIcon(c,{...n,x:0,y:0},r*.62,'#eef1ff')}c.restore();
    a.ver++;a.bmp=null;const value={atlas:a,sx:x,sy:y,size,half,r};sprites.set(key,value);return value}
  let lastVisible=null;
  function frameSignature(){let sum=0;if(mode==='map')for(const n of S.visible)sum+=n.x+n.y*1.7;
    return [mode,S.st.layout,S.W,S.H,chromeTop,yaw,pitch,zoom,pan.x,pan.y,ringAngles.A,ringAngles.R,ringAxis.A,ringAxis.R,S.cam.x,S.cam.y,S.cam.k,timeScale,timePan.x,timePan.y,timelineVersion,S.hover?.id,S.sel?.id,S.focusSet?.size,links,glow,labels,S.st.quietMono,Math.round(fileLabelAlpha*1000),spriteGen,signature,JSON.stringify(S.st.layers),JSON.stringify(S.st.depts),sum.toFixed(2)].join('|')}
  // Hex backdrop: the live
  // board's drawHex pattern (20 px hexes, fading with distance from the centre) at half its brightness, so it reads as a
  // faint texture on true black. Built once per size. The Timeline keeps plain black under its own day grid.
  // It is drawn once per size on its own canvas under the renderer (hexLayer), never per frame.
  // Same strength as the /agenticos homepage hex (0.064 at the centre x its 0.85 layer opacity).
  const HEX_ALPHA=.07;let hexBg=null,hexKey='',bgNow=-1,hexNow=-1;
  function setBackdrop(bgA,hexA){if(!hexBg)return;hexBackdrop();bgA=Math.round(bgA*1000)/1000;hexA=Math.round(hexA*1000)/1000;
    if(bgA!==bgNow){bgNow=bgA;document.documentElement.classList.toggle('see-through',bgA<1);document.documentElement.style.setProperty('--port-bg',String(bgA))}
    if(hexA!==hexNow){hexNow=hexA;hexBg.style.opacity=String(hexA)}}
  function hexBackdrop(){const key=S.W+'x'+S.H+'@'+S.DPR;if(hexKey===key)return hexBg;hexKey=key;hexBg.width=S.W*S.DPR;hexBg.height=S.H*S.DPR;
    const g=hexBg.getContext('2d'),W=S.W,H=S.H,size=20,hs=size*Math.sqrt(3),vs=size*1.5,cx0=W/2,cy0=H/2,maxD=Math.hypot(cx0,cy0);g.setTransform(S.DPR,0,0,S.DPR,0,0);g.clearRect(0,0,W,H);g.lineWidth=.6;
    for(let row=-1;row<H/vs+2;row++)for(let col=-1;col<W/hs+2;col++){const hx=col*hs+(row%2?hs/2:0),hy=row*vs,fade=Math.max(0,1-Math.hypot(hx-cx0,hy-cy0)/maxD*.6),alpha=HEX_ALPHA*fade*fade;g.beginPath();for(let i=0;i<6;i++){const a=Math.PI/3*i-Math.PI/6,px=hx+size*Math.cos(a),py=hy+size*Math.sin(a);i?g.lineTo(px,py):g.moveTo(px,py)}g.closePath();g.strokeStyle='rgba(127,166,255,'+alpha+')';g.stroke()}
    // Chrome holds a canvas's ~2,000 strokes until it is first shown, then rasters them in one go (a ~60 ms hitch on the
    // first zoom in). Taking a snapshot now makes it raster here, while the brain is still loading out of sight.
    if(typeof createImageBitmap==='function')createImageBitmap(hexBg).then(b=>b.close()).catch(()=>{});
    return hexBg}
  // Zoom in from the homepage:
  // the brain starts exactly where the homepage's mini 3D brain sits, at its size, turn and ring angles, and grows
  // to the opening camera. Scale moves in log space, so the zoom speed feels even. zoomStart() sets it up.
  let zoomTr=null;const OPEN_PITCH=-.42,wrapA=a=>Math.atan2(Math.sin(a),Math.cos(a));
  function zoomStart(pose,dir){if(!S||!pose||!(pose.r>0))return null;if(dir===1){zoom=1;pan.x=pan.y=0;focusMove=null}const f=frame(),cur={yaw,pitch},mini={yaw:pose.yaw,pitch:pose.pitch},end=dir===1?{yaw:mini.yaw,pitch:OPEN_PITCH}:cur;
    mini.yaw=end.yaw+wrapA(mini.yaw-end.yaw);if(dir===1&&pose.rings){ringAngles.A=pose.rings.angA;ringAngles.R=pose.rings.angR;ringAxis.A=pose.rings.axA;ringAxis.R=pose.rings.axR}
    zoomTr={s0:clamp(pose.r/f.r,.03,1),sx:pose.x,sy:pose.y,camA:mini,camB:end};return {s0:zoomTr.s0,cx:f.cx,cy:f.cy,r:f.r}}
  const zoomOn=()=>unfold?.style==='zoom'&&zoomTr;
  function zoomAt(q){const f=frame(),s=Math.pow(zoomTr.s0,1-q);return{f,s,cx:zoomTr.sx+(f.cx-zoomTr.sx)*q,cy:zoomTr.sy+(f.cy-zoomTr.sy)*q}}
  function unfoldTransform(p){if(!unfold)return p;
    if(zoomOn()){const z=zoomAt(unfold.progress);return{...p,x:z.cx+(p.x-z.f.cx)*z.s,y:z.cy+(p.y-z.f.cy)*z.s,scale:p.scale*z.s,alpha:(p.alpha??1)*smooth(clamp(unfold.progress/.3))}}const progress=smooth(unfold.progress),f=frame(),source=unfold.source||{x:S.W/2,y:S.H*.45,r:f.r*.82},scale=.82+.18*progress,dx=(source.x-f.cx)*(1-progress),dy=(source.y-f.cy)*(1-progress);return{...p,x:f.cx+(p.x-f.cx)*scale+dx,y:f.cy+(p.y-f.cy)*scale+dy,scale:p.scale*scale}}
  function draw(force=false){radKey=S?S.st.size+'|'+S.st.armsSize+'|'+S.st.hubSize:'';
    if(!S||!canvas||(!active&&!unfold&&!force))return;
    // speed: the shell keeps this frame fully transparent until the unfold passes .24, so skip drawing it there (it was redrawing behind the homepage every frame)
    // (the zoom shows the brain from the first moment, so it only stops at 0, where the shell hides this frame)
    if(unfold&&(zoomOn()?unfold.progress<=0:unfold.progress<=.24)&&!force)return;if(iconsDirty&&performance.now()-iconsRebuilt>150){sprites.clear();atlasReset();spriteGen++;iconsDirty=false;iconsRebuilt=performance.now()}if(mode==='map'){S.tick+=clamp((performance.now()-last)/16.67,.5,2.4)||1;if(S.st.layout==='rings')BrainCore.placeRings()}/* ticks follow time (60 a second), so the rings turn at the same pace at 30 fps */const now=performance.now(),dt=Math.min(.04,(now-last)/1000||.016);last=now;
    // File names fade in as you zoom the globe, and ease over time so a wheel step never pops them in.
    const labelTarget=labels&&S.st.fileLabels&&mode==='orbs'?smooth(clamp((zoom-1.6)/1.1)):0;fileLabelAlpha+=(labelTarget-fileLabelAlpha)*(reduced?1:Math.min(1,dt*3));settle();BrainCore.rebuildFocus();
    if(focusMove){const f=focusMove,t=reduced?1:clamp((now-f.start)/650),e=smooth(t),mix=(a,b)=>a+(b-a)*e;
      if(f.kind!==mode)focusMove=null;
      else if(f.kind==='map'){S.cam.k=mix(f.from.k,f.to.k);S.cam.x=mix(f.from.x,f.to.x);S.cam.y=mix(f.from.y,f.to.y)}
      else if(f.kind==='timeline'){timeScale=mix(f.scale,f.toScale);timePan.x=mix(f.pan.x,f.toPan.x);timePan.y=mix(f.pan.y,f.toPan.y)}
      else{yaw=mix(f.yaw,f.toYaw);pitch=mix(f.pitch,f.toPitch);zoom=mix(f.zoom,f.toZoom);pan.x=mix(f.pan.x,f.toPan.x);pan.y=mix(f.pan.y,f.toPan.y)}
      if(t===1)focusMove=null}
    // a selected node holds still: the rings stop turning too, so a ring node stays where the zoom put it
    if(motion&&active&&mode==='orbs'&&!unfold&&!changing&&!reveal&&!reduced&&!S.sel){const ms=dt*motionSpeed;ringAngles.A+=ms*.066;ringAngles.R-=ms*.0864;ringAngles.X+=ms*.05;ringAxis.X+=ms*.028;ringAxis.A+=ms*.042;ringAxis.R-=ms*.0324;
      // the camera moves the way a slow hand drag does: around the globe, with a gentle rise and fall
      if(!drag&&!S.hover&&!S.sel&&!focusMove&&!$('brain-viewer')?.classList.contains('open')){driftT+=ms;yaw+=ms*.11;const off=.2*Math.sin(driftT*.23);pitch=clamp(pitch+off-driftOff,-1.5,1.5);driftOff=off}}
    const style=[S.st.quietMono,glow,S.st.shapes,S.st.size,S.st.armsSize,S.st.msat].join('|');if(style!==styleKey){sprites.clear();atlasReset();spriteGen++;styleKey=style}
    $('timeline-legend').hidden=mode!=='timeline';if(mode==='timeline')buildTimeline();
    // Draw only when something on screen can have changed: a settled map, a still timeline or a
    // globe with Motion off cost nothing while you look at them.
    if(S.hover!==hoverNode){hoverNode=S.hover;hoverAt=now}if(S.sel!==selNode){selNode=S.sel;selAt=S.sel?now:-1e9}const microLive=!reduced&&(now-hoverAt<200||now-selAt<720);
    if(!force&&!changing&&!unfold&&!reveal&&!focusMove&&!microLive){const sig=frameSignature();if(sig===lastSig)return;lastSig=sig}else lastSig='';drawnFrames++;
    const t=changing?(changing.duration?clamp((now-changing.start)/changing.duration):1):1,e=smooth(t),orbAlpha=(changing?(mode==='orbs'?e:changing.previous==='orbs'?1-e:0):mode==='orbs'?1:0)*(zoomOn()?smooth(clamp(unfold.progress/.3)):1);
    // zoom: the background stays see-through at first, so the brain grows straight out of the homepage orb, then turns black
    // speed: the black is the page's own background and the hex sits on its own still layer under this canvas, so neither is
    // redrawn per frame; only their opacity changes (zoom: see-through at first; Timeline: no hex)
    const bgA=zoomOn()?smooth(clamp((unfold.progress-.3)/.5)):1;setBackdrop(bgA,(mode==='timeline'?(changing?1-e:0):(changing?.previous==='timeline'?e:1))*bgA);
    ctx.setTransform(S.DPR,0,0,S.DPR,0,0);ctx.clearRect(0,0,S.W,S.H);ctx.save();
    const useG=useGL();if(useG){topCtx.setTransform(1,0,0,1,0,0);topCtx.clearRect(0,0,topCanvas.width,topCanvas.height);topCtx.setTransform(S.DPR,0,0,S.DPR,0,0);GLR.begin();shellPending=false}
    if(mode==='timeline')drawTimeline(e);
    const drawable=[];points=new Map();
    for(const n of S.visible){if(!shown(n))continue;let p=target(n),alpha=1;const targetAlpha=p?1:0;if(!p){if(!changing)continue;p=timelineAnchor(n)}if(changing){let a=changing.from.get(n.id);const fromAlpha=a?(a.alpha??1):0;if(!a)a=changing.previous==='timeline'?timelineAnchor(n):p;alpha=fromAlpha+(targetAlpha-fromAlpha)*e;p={...p,x:a.x+(p.x-a.x)*e,y:a.y+(p.y-a.y)*e,z:a.z+(p.z-a.z)*e,scale:a.scale+(p.scale-a.scale)*e}}p=unfoldTransform({...p,alpha});if(reveal&&mode==='orbs'){const elapsed=now-reveal.start,delay=hash(n.id)*1250,entry=reduced?1:smooth(clamp((elapsed-delay)/900)),f=frame();p.x=f.cx+(p.x-f.cx)*(.74+.26*entry);p.y=f.cy+(p.y-f.cy)*(.74+.26*entry);p.scale*=.55+.45*entry;p.alpha=(p.alpha??1)*entry}points.set(n.id,p);drawable.push({n,p})}
    const mapShown=mode==='map'||changing?.previous==='map';mapGroups=mapShown?buildMapGroups(drawable):null;if(mapShown)drawMap(changing?(mode==='map'?e:1-e):1);
    currentShell=null;applyUnfold();
    drawShells(orbAlpha);ctx.restore();drawEdges(changing?Math.pow(Math.abs(2*e-1),2):1);drawable.sort((a,b)=>a.p.z-b.p.z);
    const oldCam=S.cam,oldTick=S.tick,oldGlow=S.st.glow;S.tick=0;S.st.glow=glow?.65:0;S.cam={k:1,x:0,y:0};
    // speed: every canvas call is replayed in the GPU process, so alpha and colour are only set when they change.
    // Alpha snaps to 1/255 steps (the canvas stores 8-bit colour anyway), so nodes at nearly the same depth share one set.
    let ga=-1,fs='';const setA=v=>{v=Math.round(v*255)/255;if(v!==ga)ctx.globalAlpha=ga=v},setF=v=>{if(v!==fs)ctx.fillStyle=fs=v};
    const labelQueue=[];let frontDone=!currentShell;const drawFront=()=>{frontDone=true;
      // WebGL: the front shell is painted on its own canvas and handed to the GL layer, which puts it between the back and front nodes
      if(useG){GLR.mark();const keep=ctx;ctx=shellCtx;ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,shellCanvas.width,shellCanvas.height);ctx.setTransform(S.DPR,0,0,S.DPR,0,0);ctx.save();applyUnfold();drawShellLayer(currentShell,'front');ctx.restore();ctx=keep;shellPending=true;return}
      ctx.save();applyUnfold();drawShellLayer(currentShell,'front');ctx.restore()};
    for(const ent of drawable){const n=ent.n,p=ent.p;if(!frontDone&&p.z>=currentShell.split)drawFront();if(p.x<-100||p.x>S.W+100||p.y<-100||p.y>S.H+100)continue;const timeMix=mode==='timeline'?changing?e:1:changing?.previous==='timeline'?1-e:0;const dim=S.focusSet&&!S.focusSet.has(n.id),baseDepth=clamp(.63+p.z/Math.max(600,frame().r*3),.35,1),depth=mode==='map'?1:baseDepth,r=ent.r??rad(n),scale=p.scale,alpha=p.alpha??1;const temporal=timePositions.get(n.id),isIcon=temporal?.icon,drawTime=timeMix>0&&!isIcon,timeRadius=temporal?.r||2.2;p.renderRadius=timeRadius*timeScale*timeMix+r*scale*(1-timeMix);
      if(drawTime){setA((dim?.18:.78)*timeMix*alpha);setF(n===S.sel||n===S.hover?'#a37cff':S.st.quietMono?'#aab3da':S.colorOf(n));ctx.beginPath();ctx.arc(p.x,p.y,timeRadius*timeScale,0,TAU);ctx.fill();p.hit=Math.max(6,timeRadius*timeScale);if(timeMix>.999)continue}
      const nodeAlpha=depth*(dim?.14:1)*(isIcon?1:1-timeMix)*alpha;if(nodeAlpha>.004){const hg=n===S.hover?(reduced?1:smooth(clamp((now-hoverAt)/160))):0,glyph=sprite(n,r),h=glyph.half*scale*(r/glyph.r)*(1+.12*hg);if(useG)GLR.push(glyph.atlas,glyph.sx,glyph.sy,glyph.size,p.x-h,p.y-h,h*2,nodeAlpha);else{setA(nodeAlpha);ctx.drawImage(glyph.atlas.bmp||glyph.atlas.c,glyph.sx,glyph.sy,glyph.size,glyph.size,p.x-h,p.y-h,h*2,h*2)}if(n===S.sel||n===S.hover){const c=useG?topCtx:ctx;if(useG)c.globalAlpha=nodeAlpha;c.strokeStyle='#e8e8e0';c.lineWidth=1;c.beginPath();c.arc(p.x,p.y,(r+5+2*hg)*scale,0,TAU);c.stroke();if(n===S.sel&&!reduced&&now-selAt<720){const k=clamp((now-selAt)/720),q=1-Math.pow(1-k,3);c.globalAlpha=nodeAlpha*(1-k)*.8;c.beginPath();c.arc(p.x,p.y,(r+5)*scale+16*q,0,TAU);c.stroke();c.globalAlpha=nodeAlpha}}}p.hit=Math.max(6,r*scale);
      const focusLabel=n.type==='router'||n===S.hover||n===S.sel,labelAlpha=focusLabel?1:fileLabelAlpha*depth;if(!focusLabel&&labelAlpha>.02&&mode==='orbs'&&!unfold){labelQueue.push({text:n.label,x:p.x,y:p.y+Math.max(17,r*scale)+16,a:alpha*labelAlpha,z:p.z});continue}if(focusLabel&&mode!=='timeline'&&!unfold){if(useG){topCtx.globalAlpha=alpha*labelAlpha;topCtx.fillStyle='#dedede'}else{setA(alpha*labelAlpha);setF('#dedede')}const lc=useG?topCtx:ctx;lc.font='400 11px Segoe UI Variable,Segoe UI,sans-serif';lc.textAlign='center';lc.fillText(n.type==='router'?'AGENTS md':n.label,p.x,p.y+Math.max(17,r*scale)+16)}
    }
    if(!frontDone)drawFront();
    // WebGL: one draw for every node; everything after the nodes (labels, rings, overlays) goes on the top canvas
    if(useG){GLR.end(atlases,shellPending?shellCanvas:null);ctx=topCtx}
    try{drawLabelQueue(labelQueue);if(!useG)freezeAtlases();S.cam=oldCam;S.tick=oldTick;S.st.glow=oldGlow;ctx.globalAlpha=1;if(!unfold)drawShells(orbAlpha,true);if(mode==='map')drawMapLabels(capAlpha(t));if(mode==='timeline')BrainTimeline.overlay(ctx,{layout:timelineLayout,S,scale:timeScale,pan:timePan,alpha:changing?e:1});if(reveal&&now-reveal.start>2250)reveal=null;if(changing&&t===1){changing=null;postState()}}finally{ctx=baseCtx}
  }
  function hit(x,y){let result=null,best=Infinity;for(const n of S.visible){if(!shown(n))continue;const p=points.get(n.id);if(!p)continue;const d=Math.hypot(p.x-x,p.y-y);if(d<(p.hit||7)&&d<best){best=d;result=n}}return result}
  function select(n){BrainCore.select(n);if(n?.type==='dir'){n.expanded?BrainCore.collapseDir(n.id):BrainCore.expandDir(n.id);timelineDirty=true}if(n?.type==='file'&&n===S._portLastPick)BrainCore.openViewer(n.path);S._portLastPick=n}
  // Selecting a node (a click, the file search, Fly to) zooms to it in every view. The
  // camera eases for 650 ms and lands the node in the middle of the space the info card leaves free.
  // On the globe the node turns to the front, then tilts a little off centre so it never sits on the
  // AGENTS md hub in the middle, and the pan brings it back to that free middle.
  const FOCUS_ZOOM={A:2,R:2.2,M:3.2,S:4.2};
  function focusSpot(){const a=area(),c=$('brain-card'),v=$('brain-viewer'),l=c&&c.style.display!=='none'?c.getBoundingClientRect().right+12:0,r=v?.classList.contains('open')?S.W-16-v.offsetWidth-12:S.W;return{x:(l+r)/2,y:a.top+a.h*.5}}
  function orbAt(n,y,p,z){const keep=[yaw,pitch,zoom,pan.x,pan.y];yaw=y;pitch=p;zoom=z;pan.x=pan.y=0;const q=orbPoint(n);[yaw,pitch,zoom,pan.x,pan.y]=keep;return q}
  function focus(id){const n=S.byId.get(id);if(!n)return;const spot=focusSpot(),start=performance.now();
    if(mode==='map'){const k=Math.max(S.cam.k,1.6);focusMove={kind:'map',start,from:{...S.cam},to:{k,x:spot.x-n.x*k,y:spot.y-n.y*k}};return}
    if(mode==='timeline'){const p=timePositions.get(id);if(!p)return;const s=Math.max(timeScale,3);focusMove={kind:'timeline',start,scale:timeScale,pan:{...timePan},toScale:s,toPan:{x:spot.x-S.W/2-(p.x-S.W/2)*s,y:spot.y-S.H/2-(p.y-S.H/2)*s}};return}
    const hub=n.type==='router',h=homes.get(id);if(!h&&!hub)return;const k=layer(n),v=hub?{x:0,y:0,z:1}:h.ring?ringVector(k,h.angle):h;let toYaw=-Math.atan2(v.x,v.z);while(toYaw-yaw>Math.PI)toYaw-=TAU;while(toYaw-yaw<-Math.PI)toYaw+=TAU;
    const toZoom=Math.max(zoom,hub?1.7:FOCUS_ZOOM[k]||3),toPitch=clamp(Math.atan2(v.y,Math.hypot(v.x,v.z))+(hub?0:.3),-1.5,1.5),q=orbAt(n,toYaw,toPitch,toZoom);
    focusMove={kind:'orbs',start,yaw,pitch,zoom,pan:{...pan},toYaw,toPitch,toZoom,toPan:{x:spot.x-q.x,y:spot.y-q.y}}}
  function zoomBy(factor,x=S.W/2,y=S.H/2){focusMove=null;if(mode==='map'){const k=clamp(S.cam.k*factor,.04,9),ratio=k/S.cam.k;S.cam.x=x+(S.cam.x-x)*ratio;S.cam.y=y+(S.cam.y-y)*ratio;S.cam.k=k}else if(mode==='timeline'){const z=clamp(timeScale*factor,.5,15),ratio=z/timeScale;timePan.x=x-S.W/2+(timePan.x-(x-S.W/2))*ratio;timePan.y=y-S.H/2+(timePan.y-(y-S.H/2))*ratio;timeScale=z}else zoom=clamp(zoom*factor,.35,6);postState()}
  function reset(){zoom=1;pan={x:0,y:0};yaw=.27;pitch=-.42;timeScale=1;timePan={x:0,y:0};BrainCore.select(null);fitMap();postState()}
  function resize(){if(!canvas)return;canvas.width=S.W*S.DPR;canvas.height=S.H*S.DPR;canvas.style.width=S.W+'px';canvas.style.height=S.H+'px';if(GLR){GLR.resize(S.W,S.H,S.DPR);topCanvas.width=shellCanvas.width=canvas.width;topCanvas.height=shellCanvas.height=canvas.height;lastSig=''}timelineDirty=true;if(mode==='map')fitMap()}
  function state(){return{ready:!!S,active,view:mode,mode,layout:S?.st.layout,motion,links,glow,colours:S?!S.st.quietMono:false,labels,zoom:mode==='map'?S?.cam.k:mode==='timeline'?timeScale:zoom,transitioning:!!changing,unfold:unfold?.progress??1,centre:S?frame():null,orientation:{yaw,pitch},playing:!!reveal,labelFade:fileLabelAlpha,drawnFrames,sprites:sprites.size,atlases:atlases.length,memorySectors:memorySectors.map(x=>({...x})),physics:{kind:S?.simKind,alpha:S?.sim?.alpha(),dragged:S?.drag?.id||null},nodeCount:points.size,nodes:S?.visible.filter(shown).length,layers:S?{...S.st.layers}:{},departments:S?{...S.st.depts}:{},ringAngles:{...ringAngles},ringAxis:{...ringAxis},mapLabels:mode==='map'?{layers:keys.filter(k=>S.st.layers[k]!==false),departments:S.departments.filter(d=>S.st.depts[d.key]!==false).map(d=>d.key)}:null,captions:mode==='map'?mapCaptions.map(c=>({...c})):null,radii:{A:1,R:.81,M:.59,S:.19},timeline:{count:timePositions.size,lanes:timeLanes.map(l=>l.key),dotRadius:2.2,columns:timelineBounds?.columns,bottomUp:true,months:timelineLayout?.months.map(m=>m.label),lanesDetail:timeLanes.map(l=>({key:l.key,height:l.height})),clusters:timelineLayout?.clusters.map(c=>({key:c.key,count:c.nodes.length,top:c.top,bottom:c.bottom})),olderIncludesUndated:true},positions:[...points].map(([id,p])=>({id,...p})),homes:[...homes].map(([id,p])=>({id,...p})),selected:S?.sel?.id||null,background:'#060d22'}}
  function postState(){if(S)parent.postMessage({type:'brain-copy-state',state:{view:mode,layout:S.st.layout,motion,links,glow,colours:!S.st.quietMono,labels,nodeCount:points.size}},'*')}
  function capture(requestId,pointsOnly=false){
    const candidates=[...points].filter(([id,p])=>{const n=S.byId.get(id);return n&&shown(n)&&(p.alpha??1)>.02&&p.x>=0&&p.x<=S.W&&p.y>=0&&p.y<=S.H}).sort(([a],[b])=>a.localeCompare(b));
    const sample=candidates.length<=1000?candidates:Array.from({length:1000},(_,i)=>candidates[Math.floor(i*candidates.length/1000)]);
    const rendered=sample.map(([id,p])=>{const n=S.byId.get(id),raw=n.path||((n.type==='file'||n.type==='dir'||n.type==='router')?id:null),filePath=raw?(/^[A-Za-z]:[\\/]/.test(raw)?raw:raw).replaceAll('\\','/').replace(/\/+/g,'/'):null;return{id,path:filePath,x:p.x,y:p.y,r:p.renderRadius||S.radiusOf(n)*p.scale,color:n===S.sel||n===S.hover?'#a37cff':mode==='timeline'&&S.st.quietMono?'#aab3da':S.colorOf(n)}});
    // the picture travels as an ImageBitmap (no PNG encode or decode); the view being entered sends positions only
    const send=extra=>parent.postMessage({type:'brain-copy-capture',requestId,width:S.W,height:S.H,points:rendered,...extra},'*',extra.bitmap?[extra.bitmap]:[]);
    if(pointsOnly){send({});return}
    // with the WebGL layer the picture is three canvases: redraw now, then flatten them in the same task (the GL buffer is only readable until the frame is shown)
    // the black and the hex are their own layers now, so they are added here too
    if(useGL())draw(true);const pic=document.createElement('canvas');pic.width=canvas.width;pic.height=canvas.height;const o=pic.getContext('2d');o.fillStyle='#060d22';o.fillRect(0,0,pic.width,pic.height);if(hexBg&&hexNow>0){o.globalAlpha=hexNow;o.drawImage(hexBg,0,0);o.globalAlpha=1}o.drawImage(canvas,0,0);if(useGL()){o.drawImage(GLR.canvas,0,0);o.drawImage(topCanvas,0,0)}
    if(typeof createImageBitmap==='function')createImageBitmap(pic).then(bitmap=>send({bitmap})).catch(()=>send({image:pic.toDataURL('image/png')}));else send({image:pic.toDataURL('image/png')});
  }
  function ready(){setTimeout(()=>window.__loadExpansions?.(),2500);parent.postMessage({type:'brain-copy-ready',centre:frame(),nodeCount:S.visible.filter(shown).length,ready:true,source:'saved-snapshot'},'*')}
  function control(m){if(!S)return;if(m.action==='chrome'){chromeTop=Math.max(80,m.height||112);document.documentElement.style.setProperty('--chrome-top',chromeTop+'px');timelineDirty=true;if(mode==='map')fitMap();return}if(m.action==='capture'){capture(m.requestId,m.pointsOnly);return}if(m.action==='active'){active=!!(m.value??m.active);last=performance.now();if(active&&mode==='map'&&S.sim)S.sim.alpha(Math.max(.08,S.sim.alpha())).restart();else if(!active)S.sim?.stop()}if(m.action==='view')setView(m.view,m.animate!==false);if(m.action==='layout')setLayout(m.layout);if(m.action==='setting'){
      const value=!!m.value;if(m.key==='motion')motion=value;if(m.key==='links')links=value;if(m.key==='glow'){glow=value;S.st.quietGlow=value}if(m.key==='colours')S.st.quietMono=!value;if(m.key==='labels'){labels=value;S.st.fileLabels=value}BrainCore.persistSt();postState()
    }if(m.action==='layer'&&keys.includes(m.layer)){S.st.layers[m.layer]=!!m.value;timelineDirty=true;BrainCore.persistSt();postState()}if(m.action==='department'&&S.departments.some(d=>d.key===m.department)){S.st.depts[m.department]=!!m.value;timelineDirty=true;BrainCore.persistSt();postState()}if(m.action==='motionSpeed'){motionSpeed=clamp(+m.value||1,.1,4);return}if(m.action==='zoom'){if(m.direction===0)reset();else zoomBy(m.direction>0?1.2:1/1.2)}if(m.action==='transition'){
      if(m.progress<1){unfold={progress:clamp(m.progress),source:m.source,style:m.style};
        // zoom: the camera eases from the homepage orb's turn to the opening view (or back to the orb on the way out)
        if(m.style==='zoom'&&zoomTr){const q=unfold.progress;yaw=zoomTr.camA.yaw+(zoomTr.camB.yaw-zoomTr.camA.yaw)*q;pitch=zoomTr.camA.pitch+(zoomTr.camB.pitch-zoomTr.camA.pitch)*q}mode='orbs';changing=null;canvas.style.pointerEvents='none';BrainCore.select(null)}else{if(m.style==='zoom'&&zoomTr){yaw=zoomTr.camB.yaw;pitch=zoomTr.camB.pitch;zoomTr=null}unfold=null;last=performance.now();canvas.style.pointerEvents='auto';postState()}
    }if(m.action==='reset')reset();if(m.action==='ping')ready()}
  // Force view: every ARMS pillar gets its own gravity well, so Routines sit clearly apart from
// Applications. Only the layer hubs are steered; their nodes follow through the native springs
// and pulls, and dragging, release and gravity stay exactly as the engine does them.
const PILLARS={'lhub:R':[-62,470],'lhub:A':[18,560],'lhub:S':[104,190]};
function pillarForces(sim,kind,nodes){if(kind!=='force')return;
  sim.force('pillars',alpha=>{for(const id in PILLARS){const h=S.byId.get(id);if(!h||h.fx!=null||h._userHome)continue;const [deg,r]=PILLARS[id],a=deg*Math.PI/180;h.vx+=(Math.cos(a)*r-h.x)*.14*alpha;h.vy+=(Math.sin(a)*r-h.y)*.14*alpha}
    // apps gather round the Applications hub and routines round the Routines hub; the routines' links to the apps they use pulled them across otherwise
    const hA=S.byId.get('lhub:A'),hR=S.byId.get('lhub:R');for(const d of nodes){const h=d.type==='app'?hA:d.type==='routine'?hR:null;if(!h||d.fx!=null||d._userHome)continue;const k=d.type==='app'?.03:.05;d.vx+=(h.x-d.x)*k*alpha;d.vy+=(h.y-d.y)*k*alpha}})}
function init(){if(S)return;S=BrainCore.S;S.skin.extraForces=pillarForces;S.theme='dark';S.st.spin=0;S.st.quietMono=true;S.st.quietGlow=false;S.st.glow=0;S.st.fileLabels=false;S.st.layers={A:true,X:true,R:true,M:true,S:true};S.st.depts=Object.fromEntries(S.departments.map(d=>[d.key,true]));S.st.colorBy='dept';S.st.view='context';S.st.msat=1;S.st.shapes='celestial';S.fly=null;
    const legend=document.createElement('div');legend.id='timeline-legend';legend.hidden=true;legend.setAttribute('aria-label','Timeline controls and departments');legend.innerHTML='<label class="timeline-range"><span>History</span><input id="timeline-range" type="range" min="0" max="0" step="1" value="0" aria-label="Timeline, three months per step"><span id="timeline-range-label">Latest 3 months</span></label>'+S.departments.map(d=>'<button data-department="'+d.key+'" aria-pressed="true" style="--dept:'+d.color+'"><i></i>'+d.label+'</button>').join('');legend.querySelectorAll('button').forEach(b=>b.onclick=()=>{const value=S.st.depts[b.dataset.department]===false;b.setAttribute('aria-pressed',value);control({action:'department',department:b.dataset.department,value})});legend.querySelector('#timeline-range').oninput=e=>{timeOffset=+e.target.value;cancelAnimationFrame(scrubRaf);scrubRaf=requestAnimationFrame(()=>{try{localStorage.setItem('agentic-hq-timeline-offset',String(timeOffset))}catch{}timelineDirty=true;timeScale=1;timePan={x:0,y:0};focusMove=null;buildTimeline();draw(true)})};legend.querySelectorAll('button[data-department]').forEach(b=>{b.addEventListener('pointerenter',()=>{if(S.sel||S.hover)return;const key=b.dataset.department,set=new Set();for(const n of S.visible)if('D:'+(n.dept||'business')===key||n.type==='hub'&&n.hubKind==='dept'&&'D:'+n.dept===key)set.add(n.id);if(!set.size)return;S.focusSet=set;S.focusLinks=null;legendDim=true;draw(true)});b.addEventListener('pointerleave',()=>{if(!legendDim)return;legendDim=false;S.focusSet=null;S.focusLinks=null;S.lastFocusKey='#legend';BrainCore.rebuildFocus();draw(true)})});document.body.append(legend);canvas=document.createElement('canvas');canvas.id='port-canvas';canvas.tabIndex=0;canvas.setAttribute('aria-label','Second brain. Drag to orbit or pan. Scroll to zoom.');document.body.append(canvas);ctx=baseCtx=canvas.getContext('2d');
    hexBg=document.createElement('canvas');hexBg.id='port-hex';hexBg.setAttribute('aria-hidden','true');hexBg.style.cssText='position:fixed;inset:0;width:100%;height:100%;z-index:3;pointer-events:none;opacity:0';canvas.before(hexBg);
    if(!/[?&]gl=0\b/.test(location.search)&&window.PortGL){GLR=PortGL.create(canvas,ATLAS);if(GLR){topCanvas=document.createElement('canvas');topCanvas.id='port-top';topCanvas.setAttribute('aria-hidden','true');topCanvas.style.cssText='position:fixed;inset:0;width:100%;height:100%;z-index:3;pointer-events:none';GLR.canvas.after(topCanvas);topCtx=topCanvas.getContext('2d');shellCanvas=document.createElement('canvas');shellCtx=shellCanvas.getContext('2d');GLR.onlost=()=>{topCtx.setTransform(1,0,0,1,0,0);topCtx.clearRect(0,0,topCanvas.width,topCanvas.height);lastSig=''}}}
    prepareMap();settle();resize();
    canvas.addEventListener('wheel',e=>{e.preventDefault();zoomBy(Math.exp(-e.deltaY*.001),e.clientX,e.clientY)},{passive:false});
    canvas.onpointerdown=e=>{if(unfold)return;const node=mode==='map'?hit(e.clientX,e.clientY):null;drag={x:e.clientX,y:e.clientY,d:0,node};focusMove=null;if(node){S.drag=node;S.fly=null;if(S.simKind){node.fx=node.x;node.fy=node.y;S.sim.alphaTarget(.28).restart()}}canvas.style.cursor='var(--cur-hex-drag),grabbing';canvas.setPointerCapture(e.pointerId)};
    canvas.onpointermove=e=>{if(unfold)return;if(drag){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag.d+=Math.abs(dx)+Math.abs(dy);if(mode==='map'&&drag.node){const n=drag.node,wx=(e.clientX-S.cam.x)/S.cam.k,wy=(e.clientY-S.cam.y)/S.cam.k;n._pin={x:wx,y:wy};n.x=wx;n.y=wy;if(S.simKind){n.fx=wx;n.fy=wy}}else if(mode==='orbs'&&!e.shiftKey){yaw+=dx*.004;pitch=clamp(pitch+dy*.004,-1.5,1.5)}else if(mode==='map'){S.cam.x+=dx;S.cam.y+=dy}else if(mode==='timeline'){timePan.x+=dx;timePan.y+=dy}else{pan.x+=dx;pan.y+=dy}drag.x=e.clientX;drag.y=e.clientY;return}S.hover=hit(e.clientX,e.clientY);canvas.style.cursor=S.hover?'var(--cur-hex-click),pointer':'var(--cur-hex-grab),grab';const tip=$('brain-tip');if(S.hover!==tipFor){tipFor=S.hover;clearTimeout(tipT);if(S.hover){tip.innerHTML=BrainCore.tipHTML(S.hover)+(mode==='timeline'?timeTip(S.hover):'');const showing=tip.style.opacity==='1';tipT=setTimeout(()=>{tip.style.opacity='1'},showing||reduced?0:90)}else tipT=setTimeout(()=>{tip.style.opacity='0'},60)}if(S.hover){tip.style.left=Math.min(S.W-280,e.clientX+16)+'px';tip.style.top=Math.min(S.H-150,e.clientY+16)+'px'}};
    function release(e){if(!drag)return;const n=drag.node,moved=drag.d>=5;if(n){n._pin=null;if(moved&&['circle','hex'].includes(S.st.layout)&&S.skin.freeDrop&&n.type!=='router'){n._bTx=n.x;n._bTy=n.y;n._userHome=true;n.fx=n.fy=null;S.sim?.alphaTarget(0).alpha(Math.max(S.sim.alpha(),.25)).restart()}else if(moved){n._sprF={x:n.x,y:n.y,t0:S.tick};if(S.simKind){n.fx=n.fy=null;S.sim.alphaTarget(0);BrainCore.refreshLayout(.5)}}else if(S.simKind&&n.type!=='router'){n.fx=n.fy=null;S.sim.alphaTarget(0)}S.drag=null}if(!moved){const picked=hit(e.clientX,e.clientY);select(picked);if(picked)setTimeout(()=>focus(picked.id),60)}drag=null;canvas.style.cursor=hit(e.clientX,e.clientY)?'var(--cur-hex-click),pointer':'var(--cur-hex-grab),grab'}
    canvas.onpointerup=release;canvas.onpointercancel=release;canvas.onpointerleave=()=>{if(!drag)S.hover=null;$('brain-tip').style.opacity='0'};canvas.ondblclick=e=>{if(mode!=='map')return;const n=hit(e.clientX,e.clientY);if(n){delete n._userHome;delete n._pin;n.fx=n.fy=null;BrainCore.setLayout(S.st.layout,true)}};
    for(const ev of ['mousemove','mouseup','mousedown'])canvas.addEventListener(ev,e=>e.stopPropagation());
    addEventListener('resize',()=>setTimeout(resize,0));document.addEventListener('keydown',e=>{if(e.target.matches('input,textarea,select'))return;if(e.key==='Escape'){e.stopImmediatePropagation();if(S.sel||$('brain-viewer')?.classList.contains('open')){BrainCore.select(null);$('brain-viewer')?.classList.remove('open');return}parent.postMessage({type:'brain-copy-back'},'*');return}if(e.key==='+'||e.key==='=')zoomBy(1.2);if(e.key==='-')zoomBy(1/1.2);if(e.key==='0')reset()},true);
    // the text viewer opening or closing on the right re-centres the selected node in the space left between it and the card
    const viewerEl=$('brain-viewer');if(viewerEl)new MutationObserver(()=>{if(S.sel&&active)focus(S.sel.id)}).observe(viewerEl,{attributes:true,attributeFilter:['class']});
    requestAnimationFrame(()=>{draw();ready();warm()});
  }
  addEventListener('message',e=>{if(e.source!==parent)return;if(e.data?.type==='brain-copy')control(e.data)});
  window.QuietPort={active:()=>!!S,draw,focus,state,select:id=>select(S.byId.get(id)),zoomStart,
    // read-only, for the speed checks: every cached sprite, its cell size and which sheet holds it
    spriteDebug:()=>[...sprites].map(([k,v])=>({k,size:v.size,atlas:atlases.indexOf(v.atlas)})),
    // for the same-look check: draw this exact frame with the WebGL layer on or off
    gl:on=>{if(!GLR)return false;glOff=!on;GLR.canvas.style.display=topCanvas.style.display=on?'':'none';draw(true);return useGL()}};
  window.BrainCopy={drawn:()=>drawnFrames,state,select:id=>select(S.byId.get(id)),control};
  addEventListener('quiet-native-ready',init,{once:true});if(window.BrainCore?.S.visible.length)init();
})();
