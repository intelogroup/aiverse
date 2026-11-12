use std::time::Instant;
use glam::{Mat4, Vec3, Vec4};
use wgpu::util::DeviceExt;
#[repr(C)] #[derive(Clone,Copy,bytemuck::Pod,bytemuck::Zeroable)]
struct V { p:[f32;3], n:[f32;3], uv:[f32;2] }
fn world(doc:&gltf::Document, idx:usize, parent:Mat4, out:&mut Vec<Mat4>) {
    let n = doc.nodes().nth(idx).unwrap();
    let m = parent * Mat4::from_cols_array_2d(&n.transform().matrix());
    out[idx]=m; for c in n.children(){ world(doc,c.index(),m,out);} }
fn tex(dev:&wgpu::Device,q:&wgpu::Queue,img:&gltf::image::Data,srgb:bool)->wgpu::TextureView{
    let rgba: Vec<u8> = match img.format {
        gltf::image::Format::R8G8B8A8 => img.pixels.clone(),
        gltf::image::Format::R8G8B8 => img.pixels.chunks(3).flat_map(|p|[p[0],p[1],p[2],255]).collect(),
        f => panic!("fmt {:?}",f) };
    let t = dev.create_texture_with_data(q,&wgpu::TextureDescriptor{label:None,size:wgpu::Extent3d{width:img.width,height:img.height,depth_or_array_layers:1},mip_level_count:1,sample_count:1,dimension:wgpu::TextureDimension::D2,
        format: if srgb {wgpu::TextureFormat::Rgba8UnormSrgb} else {wgpu::TextureFormat::Rgba8Unorm},usage:wgpu::TextureUsages::TEXTURE_BINDING,view_formats:&[]},wgpu::util::TextureDataOrder::LayerMajor,&rgba);
    t.create_view(&Default::default()) }
fn main(){
    let a:Vec<String>=std::env::args().collect();
    let (glb,cam_json,outpng)=(&a[1],&a[2],&a[3]);
    let t_all=Instant::now();
    // ---- load + CPU skin at rest pose
    let t0=Instant::now();
    let (doc,bufs,imgs)=gltf::import(glb).unwrap();
    let mut wm=vec![Mat4::IDENTITY;doc.nodes().count()];
    for s in doc.default_scene().unwrap().nodes(){ world(&doc,s.index(),Mat4::IDENTITY,&mut wm);}
    let node=doc.nodes().find(|n|n.mesh().is_some()).unwrap();
    let skin=node.skin().unwrap();
    let r0=skin.reader(|b|Some(&bufs[b.index()]));
    let ibm:Vec<Mat4>=r0.read_inverse_bind_matrices().unwrap().map(|m|Mat4::from_cols_array_2d(&m)).collect();
    let jm:Vec<Mat4>=skin.joints().enumerate().map(|(k,j)|wm[j.index()]*ibm[k]).collect();
    let prim=node.mesh().unwrap().primitives().next().unwrap();
    let rd=prim.reader(|b|Some(&bufs[b.index()]));
    let pos:Vec<[f32;3]>=rd.read_positions().unwrap().collect();
    let nrm:Vec<[f32;3]>=rd.read_normals().unwrap().collect();
    let uv:Vec<[f32;2]>=rd.read_tex_coords(0).unwrap().into_f32().collect();
    let jo:Vec<[u16;4]>=rd.read_joints(0).unwrap().into_u16().collect();
    let we:Vec<[f32;4]>=rd.read_weights(0).unwrap().into_f32().collect();
    let idx:Vec<u32>=rd.read_indices().unwrap().into_u32().collect();
    let verts:Vec<V>=(0..pos.len()).map(|i|{
        let mut m=Mat4::ZERO; for k in 0..4{ m+=jm[jo[i][k] as usize]*we[i][k]; }
        let p=m.transform_point3(Vec3::from(pos[i])); let n=m.transform_vector3(Vec3::from(nrm[i])).normalize_or_zero();
        V{p:p.to_array(),n:n.to_array(),uv:uv[i]}}).collect();
    let mat=prim.material(); let pbr=mat.pbr_metallic_roughness();
    let ib=pbr.base_color_texture().unwrap().texture().source().index();
    let inn=mat.normal_texture().unwrap().texture().source().index();
    let im=pbr.metallic_roughness_texture().unwrap().texture().source().index();
    let load_ms=t0.elapsed().as_secs_f64()*1e3;
    // ---- gpu init
    let t1=Instant::now();
    let inst=wgpu::Instance::default();
    let ad=pollster::block_on(inst.request_adapter(&wgpu::RequestAdapterOptions{power_preference:wgpu::PowerPreference::HighPerformance,..Default::default()})).unwrap();
    let info=ad.get_info();
    let (dev,q)=pollster::block_on(ad.request_device(&Default::default(),None)).unwrap();
    let (tbv,tnv,tmv)=(tex(&dev,&q,&imgs[ib],true),tex(&dev,&q,&imgs[inn],false),tex(&dev,&q,&imgs[im],false));
    let vb=dev.create_buffer_init(&wgpu::util::BufferInitDescriptor{label:None,contents:bytemuck::cast_slice(&verts),usage:wgpu::BufferUsages::VERTEX});
    let ibuf=dev.create_buffer_init(&wgpu::util::BufferInitDescriptor{label:None,contents:bytemuck::cast_slice(&idx),usage:wgpu::BufferUsages::INDEX});
    let cj:serde_json::Value=serde_json::from_str(&std::fs::read_to_string(cam_json).unwrap()).unwrap();
    let f=|k:&str|{let v=&cj[k];Vec3::new(v[0].as_f64().unwrap() as f32,v[1].as_f64().unwrap() as f32,v[2].as_f64().unwrap() as f32)};
    let (eye,tgt)=(f("pos"),f("target"));
    let vp=Mat4::perspective_rh(30f32.to_radians(),1.0,0.05,100.0)*Mat4::look_at_rh(eye,tgt,Vec3::Y);
    let ub=dev.create_buffer_init(&wgpu::util::BufferInitDescriptor{label:None,contents:bytemuck::cast_slice(&vp.to_cols_array()),usage:wgpu::BufferUsages::UNIFORM});
    let smp=dev.create_sampler(&wgpu::SamplerDescriptor{mag_filter:wgpu::FilterMode::Linear,min_filter:wgpu::FilterMode::Linear,address_mode_u:wgpu::AddressMode::Repeat,address_mode_v:wgpu::AddressMode::Repeat,..Default::default()});
    let te=|b:u32|wgpu::BindGroupLayoutEntry{binding:b,visibility:wgpu::ShaderStages::FRAGMENT,ty:wgpu::BindingType::Texture{sample_type:wgpu::TextureSampleType::Float{filterable:true},view_dimension:wgpu::TextureViewDimension::D2,multisampled:false},count:None};
    let bgl=dev.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor{label:None,entries:&[
        wgpu::BindGroupLayoutEntry{binding:0,visibility:wgpu::ShaderStages::VERTEX,ty:wgpu::BindingType::Buffer{ty:wgpu::BufferBindingType::Uniform,has_dynamic_offset:false,min_binding_size:None},count:None},
        te(1),te(2),te(3),
        wgpu::BindGroupLayoutEntry{binding:4,visibility:wgpu::ShaderStages::FRAGMENT,ty:wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),count:None}]});
    let bg=dev.create_bind_group(&wgpu::BindGroupDescriptor{label:None,layout:&bgl,entries:&[
        wgpu::BindGroupEntry{binding:0,resource:ub.as_entire_binding()},
        wgpu::BindGroupEntry{binding:1,resource:wgpu::BindingResource::TextureView(&tbv)},
        wgpu::BindGroupEntry{binding:2,resource:wgpu::BindingResource::TextureView(&tnv)},
        wgpu::BindGroupEntry{binding:3,resource:wgpu::BindingResource::TextureView(&tmv)},
        wgpu::BindGroupEntry{binding:4,resource:wgpu::BindingResource::Sampler(&smp)}]});
    let sh=dev.create_shader_module(wgpu::ShaderModuleDescriptor{label:None,source:wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into())});
    let pl=dev.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor{label:None,bind_group_layouts:&[&bgl],push_constant_ranges:&[]});
    let fmt=wgpu::TextureFormat::Rgba8UnormSrgb;
    let pipe=dev.create_render_pipeline(&wgpu::RenderPipelineDescriptor{label:None,layout:Some(&pl),
        vertex:wgpu::VertexState{module:&sh,entry_point:Some("vs"),compilation_options:Default::default(),buffers:&[wgpu::VertexBufferLayout{array_stride:32,step_mode:wgpu::VertexStepMode::Vertex,attributes:&wgpu::vertex_attr_array![0=>Float32x3,1=>Float32x3,2=>Float32x2]}]},
        fragment:Some(wgpu::FragmentState{module:&sh,entry_point:Some("fs"),compilation_options:Default::default(),targets:&[Some(fmt.into())]}),
        primitive:wgpu::PrimitiveState::default(),
        depth_stencil:Some(wgpu::DepthStencilState{format:wgpu::TextureFormat::Depth32Float,depth_write_enabled:true,depth_compare:wgpu::CompareFunction::Less,stencil:Default::default(),bias:Default::default()}),
        multisample:wgpu::MultisampleState{count:4,..Default::default()},multiview:None,cache:None});
    let sz=wgpu::Extent3d{width:768,height:768,depth_or_array_layers:1};
    let mk=|f,u,c|dev.create_texture(&wgpu::TextureDescriptor{label:None,size:sz,mip_level_count:1,sample_count:c,dimension:wgpu::TextureDimension::D2,format:f,usage:u,view_formats:&[]});
    let msaa=mk(fmt,wgpu::TextureUsages::RENDER_ATTACHMENT,4).create_view(&Default::default());
    let resolve=mk(fmt,wgpu::TextureUsages::RENDER_ATTACHMENT|wgpu::TextureUsages::COPY_SRC,1);
    let rv=resolve.create_view(&Default::default());
    let dv=mk(wgpu::TextureFormat::Depth32Float,wgpu::TextureUsages::RENDER_ATTACHMENT,4).create_view(&Default::default());
    let rb=dev.create_buffer(&wgpu::BufferDescriptor{label:None,size:768*768*4,usage:wgpu::BufferUsages::COPY_DST|wgpu::BufferUsages::MAP_READ,mapped_at_creation:false});
    let init_ms=t1.elapsed().as_secs_f64()*1e3;
    let render=|read:bool|->Vec<u8>{
        let mut e=dev.create_command_encoder(&Default::default());
        { let mut p=e.begin_render_pass(&wgpu::RenderPassDescriptor{label:None,
            color_attachments:&[Some(wgpu::RenderPassColorAttachment{view:&msaa,resolve_target:Some(&rv),ops:wgpu::Operations{load:wgpu::LoadOp::Clear(wgpu::Color{r:0.2159,g:0.2461,b:0.2789,a:1.0}),store:wgpu::StoreOp::Discard}})],
            depth_stencil_attachment:Some(wgpu::RenderPassDepthStencilAttachment{view:&dv,depth_ops:Some(wgpu::Operations{load:wgpu::LoadOp::Clear(1.0),store:wgpu::StoreOp::Discard}),stencil_ops:None}),..Default::default()});
          p.set_pipeline(&pipe);p.set_bind_group(0,&bg,&[]);p.set_vertex_buffer(0,vb.slice(..));p.set_index_buffer(ibuf.slice(..),wgpu::IndexFormat::Uint32);p.draw_indexed(0..idx.len() as u32,0,0..1); }
        if read { e.copy_texture_to_buffer(wgpu::ImageCopyTexture{texture:&resolve,mip_level:0,origin:Default::default(),aspect:Default::default()},wgpu::ImageCopyBuffer{buffer:&rb,layout:wgpu::ImageDataLayout{offset:0,bytes_per_row:Some(3072),rows_per_image:Some(768)}},sz); }
        q.submit([e.finish()]); dev.poll(wgpu::Maintain::Wait);
        if read { let sl=rb.slice(..); sl.map_async(wgpu::MapMode::Read,|_|{}); dev.poll(wgpu::Maintain::Wait); let d=sl.get_mapped_range().to_vec(); rb.unmap(); d } else {vec![]} };
    let t2=Instant::now(); let px=render(true); let first_ms=t2.elapsed().as_secs_f64()*1e3;
    let mut warm=vec![]; for _ in 0..3 { let t=Instant::now(); let _=render(true); warm.push((t.elapsed().as_secs_f64()*1e3*10.0).round()/10.0); }
    image::save_buffer(outpng,&px,768,768,image::ColorType::Rgba8).unwrap();
    println!("{}",serde_json::json!({"adapter":format!("{}/{:?}/{}",info.name,info.backend,info.driver),"loadMs":load_ms.round(),"gpuInitMs":init_ms.round(),"firstRenderMs":(first_ms*10.0).round()/10.0,"warmMs":warm,"processMs":(t_all.elapsed().as_secs_f64()*1e3).round(),"tris":idx.len()/3}));
    let _=Vec4::ZERO;
}
