import { createContext, useContext, useState, useCallback, useRef, type ReactNode } from "react";

interface VehicleState {
  /** body number -> car id */
  driverOf: Map<number, string>;
  /** car id -> body number */
  carDriver: Map<string, number>;
}

interface VehicleContextValue {
  /** Enter a vehicle: assign driver to car. */
  enter: (carId: string, bodyN: number) => void;
  /** Exit a vehicle. */
  exit: (carId: string) => void;
  /** Get the driver body number for a car, or null. */
  driverOfCar: (carId: string) => number | null;
  /** Get the car id an agent is driving, or null. */
  carOfDriver: (bodyN: number) => string | null;
  /** Bump to trigger re-render when occupancy changes. */
  version: number;
}

const VehicleContext = createContext<VehicleContextValue | null>(null);

export function VehicleProvider({ children }: { children: ReactNode }) {
  const state = useRef<VehicleState>({ driverOf: new Map(), carDriver: new Map() });
  const [version, setVersion] = useState(0);

  const enter = useCallback((carId: string, bodyN: number) => {
    // If agent already driving another car, exit first
    const prevCar = state.current.driverOf.get(bodyN);
    if (prevCar) {
      state.current.carDriver.delete(prevCar);
    }
    // If car already has a driver, they're kicked out
    const prevDriver = state.current.carDriver.get(carId);
    if (prevDriver !== undefined) {
      state.current.driverOf.delete(prevDriver);
    }
    state.current.driverOf.set(bodyN, carId);
    state.current.carDriver.set(carId, bodyN);
    setVersion((v) => v + 1);
  }, []);

  const exit = useCallback((carId: string) => {
    const driver = state.current.carDriver.get(carId);
    if (driver !== undefined) {
      state.current.driverOf.delete(driver);
      state.current.carDriver.delete(carId);
      setVersion((v) => v + 1);
    }
  }, []);

  const driverOfCar = useCallback((carId: string) => {
    return state.current.carDriver.get(carId) ?? null;
  }, []);

  const carOfDriver = useCallback((bodyN: number) => {
    return state.current.driverOf.get(bodyN) ?? null;
  }, []);

  return (
    <VehicleContext.Provider value={{ enter, exit, driverOfCar, carOfDriver, version }}>
      {children}
    </VehicleContext.Provider>
  );
}

export function useVehicle(): VehicleContextValue {
  const ctx = useContext(VehicleContext);
  if (!ctx) throw new Error("useVehicle must be used within VehicleProvider");
  return ctx;
}