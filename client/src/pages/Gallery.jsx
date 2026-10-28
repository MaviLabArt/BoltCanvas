import React, { useEffect, useMemo, useState } from "react";
import ProductCard from "../components/ProductCard.jsx";
import api from "../services/api.js";

export default function Gallery() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    api.get("/products")
      .then((r) => {
        setProducts(Array.isArray(r.data) ? r.data : []);
        setLoadError(false);
      })
      .catch(() => {
        setProducts([]);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  }, []);

  const available = useMemo(
    () => products.filter(
      (p) => p.artworkStatus === "for_sale" && p.available
    ),
    [products]
  );

  const archive = useMemo(
    () => products.filter(
      (p) => p.artworkStatus !== "for_sale" || !p.available
    ),
    [products]
  );

  const gridClass =
    "grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-5";

  const renderGrid = (items) => (
    <div className={gridClass}>
      {items.map((p) => (
        <ProductCard key={p.id} p={p} />
      ))}
    </div>
  );

  return (
    <section className="py-8">
      <header className="mb-10 text-center">
        <h1 className="heading text-3xl sm:text-4xl font-semibold tracking-tight">
          Gallery
        </h1>
        <p className="mt-3 text-white/70">
          Original artworks and their stories.
        </p>
      </header>

      {loading ? (
        <p className="py-8 text-center text-white/70" role="status">
          Loading gallery…
        </p>
      ) : loadError ? (
        <p className="py-8 text-center text-white/70" role="alert">
          Unable to load the gallery. Please try again later.
        </p>
      ) : (
        <>
          <section aria-labelledby="available-heading">
            <h2
              id="available-heading"
              className="heading mb-5 text-2xl font-semibold"
            >
              Available works
            </h2>
            {available.length ? (
              renderGrid(available)
            ) : (
              <p className="text-white/60">
                No artworks are currently available for sale.
              </p>
            )}
          </section>

          <section aria-labelledby="archive-heading" className="mt-14">
            <h2
              id="archive-heading"
              className="heading mb-5 text-2xl font-semibold"
            >
              Archive
            </h2>
            {archive.length ? (
              renderGrid(archive)
            ) : (
              <p className="text-white/60">
                The archive is currently empty.
              </p>
            )}
          </section>
        </>
      )}
    </section>
  );
}
