use std::{sync::Arc, time::Instant};
use glam::{Mat4, UVec2, Vec3, Vec4};
use rend3::types::{Camera, CameraProjection, DirectionalLight, Handedness, SampleCount};
use rend3_routine::{base::BaseRenderGraph, pbr::PbrRoutine, tonemapping::TonemappingRoutine};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let (glb, camj, outpng) = (&a[1], &a[2], &a[3]);
    let t_all = Instant::now();
    let t_init = Instant::now();
    let iad = pollster::block_on(rend3::create_iad(None, None, None, None)).unwrap();
    let adapter = format!("{:?}", iad.info);
    let renderer = rend3::Renderer::new(iad.clone(), Handedness::Right, Some(1.0)).unwrap();
    let fmt = wgpu::TextureFormat::Rgba8UnormSrgb;
    let base = BaseRenderGraph::new(&renderer);
    let mut dc = renderer.data_core.lock();
    let pbr = PbrRoutine::new(&renderer, &mut dc, &base.interfaces);
    drop(dc);
    let tonemap = TonemappingRoutine::new(&renderer, &base.interfaces, fmt);
    let init_ms = t_init.elapsed().as_secs_f64() * 1e3;
    // load
    let t_load = Instant::now();
    let data = std::fs::read(glb).unwrap();
    let settings = rend3_gltf::GltfLoadSettings { enable_directional: false, ..Default::default() };
    let (_scene, _inst) = pollster::block_on(rend3_gltf::load_gltf(&renderer, &data, &settings, |u| async move {
        Err::<Vec<u8>, std::io::Error>(std::io::Error::new(std::io::ErrorKind::Other, u.to_string()))
    })).unwrap();
    let load_ms = t_load.elapsed().as_secs_f64() * 1e3;
    // lights + camera
    let _l = renderer.add_directional_light(DirectionalLight { color: Vec3::ONE, intensity: 2.5, direction: -Vec3::new(2.0, 3.0, 4.0).normalize(), distance: 10.0 });
    let cj: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(camj).unwrap()).unwrap();
    let f = |k: &str| { let v = &cj[k]; Vec3::new(v[0].as_f64().unwrap() as f32, v[1].as_f64().unwrap() as f32, v[2].as_f64().unwrap() as f32) };
    let view = Mat4::look_at_rh(f("pos"), f("target"), Vec3::Y);
    renderer.set_camera_data(Camera { projection: CameraProjection::Perspective { vfov: 30.0, near: 0.05 }, view });
    // target
    let dev = &iad.device;
    let sz = wgpu::Extent3d { width: 768, height: 768, depth_or_array_layers: 1 };
    let tex = dev.create_texture(&wgpu::TextureDescriptor { label: None, size: sz, mip_level_count: 1, sample_count: 1, dimension: wgpu::TextureDimension::D2, format: fmt, usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC });
    let view_t = Arc::new(tex.create_view(&Default::default()));
    let rb = dev.create_buffer(&wgpu::BufferDescriptor { label: None, size: 768 * 768 * 4, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let render = |read: bool| -> Vec<u8> {
        let (cmd, ready) = renderer.ready();
        let mut graph = rend3::graph::RenderGraph::new();
        base.add_to_graph(&mut graph, &ready, &pbr, None, &tonemap, UVec2::new(768, 768), SampleCount::Four, Vec4::new(0.38, 0.38, 0.38, 1.0));
        graph.execute(&renderer, rend3::util::output::OutputFrame::View(view_t.clone()), cmd, &ready);
        if read {
            let mut e = dev.create_command_encoder(&Default::default());
            e.copy_texture_to_buffer(wgpu::ImageCopyTexture { texture: &tex, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::ImageCopyBuffer { buffer: &rb, layout: wgpu::ImageDataLayout { offset: 0, bytes_per_row: std::num::NonZeroU32::new(3072), rows_per_image: std::num::NonZeroU32::new(768) } }, sz);
            iad.queue.submit(Some(e.finish()));
            let sl = rb.slice(..); let _ = sl.map_async(wgpu::MapMode::Read); dev.poll(wgpu::Maintain::Wait);
            let d = sl.get_mapped_range().to_vec(); rb.unmap(); d
        } else { dev.poll(wgpu::Maintain::Wait); vec![] }
    };
    let t = Instant::now(); let px = render(true); let first = t.elapsed().as_secs_f64() * 1e3;
    let mut warm = vec![]; for _ in 0..3 { let t = Instant::now(); let _ = render(true); warm.push((t.elapsed().as_secs_f64() * 1e4).round() / 10.0); }
    image::save_buffer(outpng, &px, 768, 768, image::ColorType::Rgba8).unwrap();
    println!("{}", serde_json::json!({"adapter": adapter, "gpuInitMs": init_ms.round(), "loadMs": load_ms.round(), "firstRenderMs": (first * 10.0).round() / 10.0, "warmMs": warm, "processMs": t_all.elapsed().as_millis()}));
}
