// Street-level furniture, in world coordinates. Keep placements, blockers and seats together.
export function furnishTeaGround(props, collision, anchors) {
  const floorY = collision.floorY;
  function place(key, x, y, z, facing = 0) {
    props.push([key, x, y, z, facing, 1]);
  }
  function seat(id, kind, x, z, facing, seatHeight, approachSide, approach) {
    collision.seats.push([x, z]);
    anchors.push({ id, building: 'tea', kind, seat: [x, z], facing, approach, approachSide, seatHeight, floorY });
  }

  for (const [id, x] of [['west', -32.05], ['east', -28.45]]) {
    const z = -75.65;
    place('tea_table', x, floorY, z);
    place('tea_service', x, floorY + .78, z);
    collision.boxes.push([x, z, .46, .46, floorY, floorY + .78, 0]);
    for (const [side, offset] of [['left', -.83], ['right', .83]]) {
      const chairX = +(x + offset).toFixed(2);
      const facing = -Math.sign(offset) * Math.PI / 2;
      place('tea_chair', chairX, floorY, z, facing);
      collision.boxes.push([chairX, z, .2, .2, floorY, floorY + .95, facing]);
      seat(`tea-${id}-${side}`, 'chair', chairX, z, facing, .49, 'back',
        [+(chairX + Math.sign(offset) * .62).toFixed(2), z]);
    }
    place('tea_lantern', x, 3.07, z);
  }

  const boothX = -27.15;
  const boothZ = -74.15;
  place('booth_2m', boothX, floorY, boothZ, Math.PI);
  collision.boxes.push([boothX, -73.46, 1, .36, floorY, floorY + .95, Math.PI]);
  for (const [side, x] of [['left', -27.75], ['right', -26.55]]) {
    seat(`tea-booth-${side}`, 'booth', x, -73.6, Math.PI, .46, 'front', [x, -74.22]);
  }
  place('tea_lantern', boothX, 3.07, boothZ);
  place('tea_service', -29.4, 1.6, -81.35);
  place('tea_cake', -31.4, 1.6, -81.35);
}
