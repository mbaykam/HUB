import type {CloudGroup} from "./knowledge-spatial-layout.ts";
type Pose={yaw:number;pitch:number};
const standard={yaw:.2,pitch:.12};
/** Choose the first/fitted VIEW; never change durable IDs or world positions.
 * Score a bounded set of orientations by separation of occupied root clouds. */
export function knowledgeFitPose(groups:readonly CloudGroup[]):Pose{
  const roots=groups.filter(group=>!group.parentId&&group.members.length).sort((a,b)=>b.members.length-a.members.length||a.id.localeCompare(b.id)).slice(0,24);
  if(roots.length<2)return {...standard};
  const radius=Math.max(135,...roots.map(group=>Math.hypot(group.x,group.y,group.z)+group.radius)),camera=Math.max(900,radius*3.5);
  const score=(pose:Pose)=>{
    const points=roots.map(group=>{const x=group.x*Math.cos(pose.yaw)-group.z*Math.sin(pose.yaw),z=group.x*Math.sin(pose.yaw)+group.z*Math.cos(pose.yaw),y=group.y*Math.cos(pose.pitch)-z*Math.sin(pose.pitch),depth=group.y*Math.sin(pose.pitch)+z*Math.cos(pose.pitch),scale=camera/(camera+depth);return {x:x*scale,y:y*scale,r:group.radius*scale};});
    let nearest=Infinity,total=0;
    for(let i=0;i<points.length;i++)for(let j=i+1;j<points.length;j++){const a=points[i]!,b=points[j]!,distance=Math.hypot(a.x-b.x,a.y-b.y)/(a.r+b.r);nearest=Math.min(nearest,distance);total+=Math.min(3,distance);}
    return nearest+total/(points.length*points.length)*.01;
  };
  let best={...standard},quality=score(best);
  for(let step=0;step<12;step++)for(const pitch of [-.55,-.3,.12,.35,.6]){const pose={yaw:standard.yaw+step*Math.PI/6,pitch},value=score(pose);if(value>quality+1e-9){best=pose;quality=value;}}
  return best;
}
