use bevy::{
    asset::AssetPlugin, camera::Exposure, core_pipeline::tonemapping::Tonemapping, prelude::*,
    render::view::screenshot::{save_to_disk, Screenshot}, world_serialization::{WorldAssetRoot, WorldInstanceReady},
    window::WindowResolution,
};
use std::time::Instant;

#[derive(Resource)]
struct T { t0: Instant, ready: Option<Instant>, frames_after: u32, shot_started: Option<Instant>, load_ms: f64 }

fn main() {
    let glb = std::env::args().nth(1).unwrap();
    let out = std::env::args().nth(2).unwrap();
    let dir = std::path::Path::new(&glb).parent().unwrap().canonicalize().unwrap();
    let name = std::path::Path::new(&glb).file_name().unwrap().to_string_lossy().to_string();
    std::env::set_var("BEVY_OUT", &out);
    std::env::set_var("BEVY_GLB", &name);
    App::new()
        .insert_resource(T { t0: Instant::now(), ready: None, frames_after: 0, shot_started: None, load_ms: 0.0 })
        .insert_resource(ClearColor(Color::srgb_u8(128, 136, 144)))
        .insert_resource(GlobalAmbientLight { color: Color::WHITE, brightness: 0.38, ..default() })
        .add_plugins(DefaultPlugins
            .set(AssetPlugin { file_path: dir.to_string_lossy().to_string(), ..default() })
            .set(WindowPlugin { primary_window: Some(Window {
                resolution: WindowResolution::new(768, 768).with_scale_factor_override(1.0),
                resizable: false, ..default() }), ..default() }))
        .add_systems(Startup, setup)
        .add_systems(Update, tick)
        .run();
}

fn setup(mut c: Commands, assets: Res<AssetServer>) {
    let name = std::env::var("BEVY_GLB").unwrap();
    c.spawn(WorldAssetRoot(assets.load(GltfAssetLabel::Scene(0).from_asset(name)))).observe(
        |_: On<WorldInstanceReady>, mut t: ResMut<T>| { t.ready = Some(Instant::now()); t.load_ms = t.t0.elapsed().as_secs_f64() * 1e3; });
    c.spawn((
        Camera3d::default(),
        Projection::Perspective(PerspectiveProjection { fov: 30f32.to_radians(), ..default() }),
        Exposure { ev100: -0.263 },
        Tonemapping::None,
        Msaa::Sample4,
        Transform::from_xyz(0.0, 0.975, 2.47).looking_at(Vec3::new(0.0, 0.975, 0.0), Vec3::Y),
    ));
    c.spawn((DirectionalLight { illuminance: 2.5, shadow_maps_enabled: false, ..default() },
        Transform::from_xyz(2.0, 3.0, 4.0).looking_at(Vec3::ZERO, Vec3::Y)));
}

fn tick(mut c: Commands, mut t: ResMut<T>) {
    if t.ready.is_none() { return; }
    t.frames_after += 1;
    if t.frames_after == 30 {
        t.shot_started = Some(Instant::now());
        let out = std::env::var("BEVY_OUT").unwrap();
        c.spawn(Screenshot::primary_window()).observe(save_to_disk(out))
         .observe(|_: On<bevy::render::view::screenshot::ScreenshotCaptured>, t: Res<T>, mut ex: MessageWriter<AppExit>| {
            println!("{{\"loadToSceneReadyMs\":{:.0},\"readyToShotMs\":{:.0},\"processMs\":{:.0}}}", t.load_ms,
                t.shot_started.unwrap().elapsed().as_secs_f64()*1e3, t.t0.elapsed().as_secs_f64()*1e3);
            ex.write(AppExit::Success); });
    }
}
